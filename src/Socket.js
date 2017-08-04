import WebSocket from 'ws'
import url from 'url'
import { EventEmitter } from 'events'

const DEFAULTS = {
  reconnect: true,
  resubscribe: true,
  keepAlive: true,
  maxTries: 5
}

export class Socket extends EventEmitter {
  constructor (ScreepsAPI) {
    super()
    this.tries = 0
    this.api = ScreepsAPI
    this.__queue = []
    this.__subQueue = []
    this.__subs = {}
    this.opts = Object.assign({}, DEFAULTS)
    this.keepAliveInter = 0
    this.on('auth', ev => {
      if (ev.data.status === 'ok') {
        while (this.__queue.length) {
          this.emit(this.__queue.shift())
        }
        clearInterval(this.keepAliveInter)
        if (this.opts.keepAlive) {
          this.keepAliveInter = setInterval(() => this.ws && this.ws.ping(1), 10000)
        }
      }
    })
  }
  async connect (opts = {}) {
    Object.assign(this.opts, opts)
    return new Promise((resolve, reject) => {
      if (!this.api.token) {
        reject(new Error('No token! Call api.auth() before connecting the socket!'))
      }
      let baseURL = this.api.opts.url.replace('http', 'ws')
      let wsurl = url.resolve(baseURL, 'socket/websocket')
      this.ws = new WebSocket(wsurl)
      this.ws.on('open', () => {
        this.connected = true
        if (this.opts.resubscribe) {
          this.__subQueue.push(...Object.keys(this.__subs))
        }
        this.emit('connected')
        resolve(this.auth(this.api.token))
      })
      this.ws.on('close', () => {
        clearInterval(this.keepAliveInter)
        this.authed = false
        this.connected = false
        this.emit('disconnected')
        if (this.opts.reconnect) {
          this.connect()
        } else {
          this.removeAllListeners()
        }
      })
      this.ws.on('error', (headers, res) => {
        this.ws.terminate()
        reject(new Error(`WS Error: ${res.statusSode} ${res.statusMessage}`))
      })
      this.ws.on('unexpected-response', (req, res) => {
        reject(new Error(`WS Unexpected Response: ${res.statusSode} ${res.statusMessage}`))
      })
      this.ws.on('message', (data) => this.handleMessage(data))
    })
  }
  async reconnect () {
    Object.keys(this.__subs).forEach(sub => this.subscribe(sub))
    this.tries++
    try {
      await this.connect()
      this.tries = 0
    } catch (err) {
      if (this.tries >= this.opts.maxTries) {
        throw new Error(`Too many connection failures ${this.tries}`)
      }
      return this.reconnect()
    }
  }
  handleMessage (msg) {
    msg = msg.data || msg // Handle ws/browser difference
    if (msg.slice(0, 3) === 'gz:') { msg = this.api.inflate(msg) }
    if (msg[0] === '[') {
      msg = JSON.parse(msg)
      let [, type, id, channel] = msg[0].match(/^(.+):(.+?)(?:\/(.+))?$/)
      channel = channel || type
      let event = { channel, id, type, data: msg[1] }
      this.emit(msg[0], event)
      this.emit(event.channel, event)
      this.emit('message', event)
    } else {
      let [channel, ...data] = msg.split(' ')
      let event = { type: 'server', channel, data }
      if (channel === 'auth') { event.data = { status: data[0], token: data[1] } }
      if (['protocol', 'time', 'package'].includes(channel)) { event.data = { [channel]: data[0] } }
      this.emit(channel, event)
      this.emit('message', event)
    }
  }
  async gzip (bool) {
    this.send(`gzip ${bool ? 'on' : 'off'}`)
  }
  async send (data) {
    if (!this.connected) {
      this.__queue.push(data)
    } else {
      this.ws.send(data)
    }
  }
  auth (token) {
    return new Promise((resolve, reject) => {
      this.send(`auth ${token}`)
      this.once('auth', (ev) => {
        let { data } = ev
        if (data.status === 'ok') {
          this.authed = true
          this.emit('token', data.token)
          this.emit('authed')
          while (this.__subQueue.length) {
            this.send(this.__subQueue.shift())
          }
          resolve()
        } else {
          reject(new Error('socket auth failed'))
        }
      })
    })
  }
  async subscribe (path, cb) {
    if (!path) return
    if (!this.api.user) { await this.api.me() }
    if (!path.match(/^([a-z]+):(.+?)$/)) { path = `user:${this.api.user._id}/${path}` }
    if (this.authed) {
      this.send(`subscribe ${path}`)
    } else {
      this.__subQueue.push(`subscribe ${path}`)
    }
    this.emit('subscribe', path)
    this.__subs[path] = this.__subs[path] || 0
    this.__subs[path]++
    if (cb) this.on(path, cb)
  }
  async unsubscribe (path) {
    if (!path) return
    if (!this.api.user) { await this.api.me() }
    if (!path.match(/^([a-z]+):(.+?)$/)) { path = `user:${this.api.user._id}/${path}` }
    this.send(`unsubscribe ${path}`)
    this.emit('unsubscribe', path)
    if (this.__subs[path]) this.__subs[path]--
  }
}
