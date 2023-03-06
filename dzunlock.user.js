// ==UserScript==
// @name        dzunlock
// @namespace   io.github.uhwot.dzunlock
// @description enables deezer hifi features lol
// @author      uh wot
// @version     1.4.3
// @license     GPL-3.0-only
// @homepageURL https://git.uhwot.cf/uhwot/dzunlock
// @downloadURL https://uhwotgit.fly.dev/uhwot/dzunlock/raw/branch/master/dzunlock.user.js
// @icon        https://cdns-files.dzcdn.net/cache/images/common/favicon/favicon-96x96.852baf648e79894b668670e115e4a375.png
// @include     /^https:\/\/www\.deezer\.com\/[a-z]{2}\/($|track|album|artist|playlist|episode|show|profile|channels|podcasts|radio|\?|#)/
// @match       https://www.deezer.com/search/*
// @match       https://www.deezer.com/account/*
// @match       https://www.deezer.com/concert/*
// @match       https://www.deezer.com/smarttracklist/*
// @require     https://cdnjs.cloudflare.com/ajax/libs/aes-js/3.1.2/index.min.js
// @grant       GM_getValue
// @run-at      document-start
// ==/UserScript==

const debug = false

function log(...args) {
    if (debug) {
        return console.log(...args)
    }
}

const playerTokenKey = [102, 228, 95, 242, 215, 50, 122, 26, 57, 216, 206, 38, 164, 237, 200, 85]
const cipher = new aesjs.ModeOfOperation.ecb(playerTokenKey)

const quality_to_format = {
    "standard": "MP3_128",
    "high": "MP3_320",
    "lossless": "FLAC"
}

function str2bin(str) {
    return Array.from(str).map(function (item) {
        return item.charCodeAt(0);
    })
}

function bin2str(bin) {
    return String.fromCharCode.apply(String, bin);
}

function decryptHex(hex) {
    hex = aesjs.utils.hex.toBytes(hex)
    return bin2str(cipher.decrypt(hex)).replace(/\0+$/, '')     // removes zero-padding
}

function encryptHex(str) {
    // zero-padding
    if (str.length % 16) {
        str += '\x00'.repeat(16 - str.length % 16)
    }

    return aesjs.utils.hex.fromBytes(cipher.encrypt(str2bin(str)))
}

function playerTokenPatch(playerToken) {
    playerToken = JSON.parse(decryptHex(playerToken))

    // enables 320/flac quality selection
    playerToken.audio_qualities.wifi_streaming = ['low', 'standard', 'high', 'lossless']
    // disables previews
    playerToken.streaming = true
    playerToken.limited = false
    // disables skip limit on mixes
    playerToken.radio_skips = 0

    log(playerToken)

    return encryptHex(JSON.stringify(playerToken))
}

window.addEventListener('DOMContentLoaded', (_) => {
    delete unsafeWindow.__DZR_APP_STATE__;
    unsafeWindow.dzPlayer.setTrackList = (function (old) {

        return function (data, ...args) {
            // needed for deezer's player to accept 320/flac responses

            for (let i = 0; i < data.data.length; i++) {
                const id = parseInt(data.data[i].SNG_ID)
                if (id >= 0) {      // don't change filesizes on user-upped tracks
                    data.data[i].FILESIZE_MP3_320 = '1'
                    data.data[i].FILESIZE_FLAC = '1'
                }
            }

            log(data)

            return old(data, ...args)
        };
    })(unsafeWindow.dzPlayer.setTrackList);
});

// https://greasyfork.org/en/scripts/38248-websocket-logger/code
unsafeWindow.WebSocket = new Proxy(unsafeWindow.WebSocket, {
    construct: function (target, args, _) {
        const url = args[0]
        const ws = new target(url)

        if (url !== 'wss://messaging.deezer.com/websocket') {
            return ws
        } else {
            log('hooking websocket')

            return new Proxy(ws, {
                set: function (target, prop, val) {
                    if (prop == 'onmessage') {
                        var onmsg = val;
                        val = function (e) {
                            if (e.data.includes('SingleInstancePlayback')) {
                                log('preventing SingleInstancePlayback pubsub receive')
                                return
                            }
                            onmsg(e)
                        };
                    }
                    return target[prop] = val
                },
                get: function (target, prop) {
                    var val = target[prop];
                    if (prop == 'send') val = function (data) {
                        if (data.includes('SingleInstancePlayback')) {
                            log('preventing SingleInstancePlayback pubsub send')
                            return
                        }
                        target.send(data)
                    };
                    else if (typeof val == 'function') val = val.bind(target)
                    return val
                }
            })
        }
    }
})

unsafeWindow.fetch = (function (fetch) {
    return async function (url, init) {
        if (url === 'https://media.deezer.com/v1/get_url') {
            let track
            if (unsafeWindow.dzPlayer.getPosition() === 0) {
                track = unsafeWindow.dzPlayer.getCurrentSong()
            } else {
                track = unsafeWindow.dzPlayer.getNextSong()    // gapless playback
            }

            const quality = unsafeWindow.dzPlayer.control.getAudioQuality()
            const id = parseInt(track.SNG_ID)

            let is_subbed = !unsafeWindow.dzPlayer.user_status.can_subscribe
            let is_quality_available = unsafeWindow.dzPlayer.user_status.audio_qualities.wifi_download.includes(quality)
            // STREAM_ADS_AVAILABLE is used to check if track is restricted to premium/hifi
            if (track.RIGHTS.STREAM_ADS_AVAILABLE !== true && !is_subbed) {
                is_quality_available = false
            }

            if (id >= 0 && !is_quality_available) {
                const media_server = GM_getValue('media_server', 'https://dzunlock-nutz.deno.dev')
                url = `${media_server}/get_url`

                const body = {
                    formats: ['FLAC', 'MP3_320', 'MP3_128', 'MP3_64', 'MP3_MISC'],
                    ids: [id]
                }

                for (let i = 0; i < body.formats.length; i++) {
                    if (body.formats[0] !== quality_to_format[quality]) {
                        body.formats.shift()
                    } else {
                        break
                    }
                }

                init.body = JSON.stringify(body)
            }
        }

        let resp = await fetch(url, init)

        if (url.startsWith('https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData')) {
            let json = await resp.json()

            // removes upgrade popup stuff
            json.results.USER.ENTRYPOINTS = {}
            // needed to play premium-restricted albums like https://www.deezer.com/album/801279
            json.results.OFFER_ID = 600
            // disables ads
            json.results.USER.OPTIONS.ads_display = false
            json.results.USER.OPTIONS.ads_audio = false

            json.results.PLAYER_TOKEN = playerTokenPatch(json.results.PLAYER_TOKEN)

            log(json)

            resp = new Response(JSON.stringify(json), resp)
        } else if (url.startsWith('https://www.deezer.com/ajax/gw-light.php?method=deezer.userMenu')) {
            let json = await resp.json()

            delete json.results.MARKETING_PUSH
            delete json.results.MARKETING_PUSH_DATA

            resp = new Response(JSON.stringify(json), resp)
        } else if (url.startsWith('https://www.deezer.com/ajax/gw-light.php?method=log.listen')) {
            const json = await resp.json()

            if (typeof json.results === 'string') {
                json.results = playerTokenPatch(json.results)
            }

            resp = new Response(JSON.stringify(json), resp)
        } else if (url.startsWith('https://www.deezer.com/ajax/gw-light.php')) {
            function crawlAndCollectSongIds(obj) {
                const objType = Object.prototype.toString.call(obj).split(' ')[1].split(']')[0]
                if (objType === 'Array') {
                    return [].concat(...new Set(obj.map(crawlAndCollectSongIds)))
                } else if (objType === 'Object') {
                    if (obj.SNG_ID && parseInt(obj.SNG_ID) > 0) {
                        return [obj.SNG_ID]
                    }
                    return [].concat(...new Set(Object.values(obj).map(crawlAndCollectSongIds))).filter(id => id) // TODO: Why do undefineds appear?
                }
            }
            let json = await resp.json()
            const songIdList = crawlAndCollectSongIds(json)
            if (songIdList.length > 0) {
                const songReplaceRes = await fetch(`${GM_getValue('media_server', 'https://dzunlock-nutz.deno.dev')}/get_song`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ids: songIdList})
                })
                if (songReplaceRes.status >= 200 && songReplaceRes.status < 300) {
                    const songReplaceList = await songReplaceRes.json()
                    function crawlAndReplaceSongs(obj) {
                        const objType = Object.prototype.toString.call(obj).split(' ')[1].split(']')[0]
                        if (objType === 'Array') {
                            for (const index in obj) {
                                obj[index] = crawlAndReplaceSongs(obj[index])
                            }
                        } else if (objType === 'Object') {
                            if (obj.SNG_ID && parseInt(obj.SNG_ID) > 0) {
                                return songReplaceList.find(song => song.SNG_ID.toString() === obj.SNG_ID.toString()) || obj
                            }
                            for (const index in obj) {
                                obj[index] = crawlAndReplaceSongs(obj[index])
                            }
                        }
                        return obj
                    }
                    json = crawlAndReplaceSongs(json)
                }
            }
            resp = new Response(JSON.stringify(json), resp)
        }

        return resp
    };
})(unsafeWindow.fetch);
