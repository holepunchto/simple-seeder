const Hyperbee = require('hyperbee')
const Hyperdrive = require('hyperdrive')
const Seeders = require('@hyperswarm/seeders')
const speedometer = require('speedometer')
const HypercoreId = require('hypercore-id-encoding')
const mutexify = require('mutexify/promise')

module.exports = class SimpleSeeder {
  constructor (store, swarm, opts = {}) {
    this.store = store
    this.swarm = swarm

    this.backup = opts.backup === true

    this.lock = mutexify()
    this.resources = new Map()
  }

  async add (key, type, opts) {
    const release = await this.lock()
    try {
      await this._add(key, type, opts)
    } finally {
      release()
    }
  }

  async _add (key, type, opts) {
    if (this.has(key)) throw new Error('Resource already added')

    const publicKey = HypercoreId.decode(key)
    const id = HypercoreId.encode(publicKey)

    // Maybe all this belongs to a "Resource" class, including the internals _createCore/Bee/etc
    const info = {
      key: id,
      type,
      instance: null,
      seeders: null,
      discovery: null,
      blocks: { down: speedometer(), up: speedometer() },
      network: { down: speedometer(), up: speedometer() },
      source: opts.source || null
    }

    if (type === 'core') info.instance = await this._createCore(publicKey, info)
    else if (type === 'bee') info.instance = await this._createBee(publicKey, info)
    else if (type === 'drive') info.instance = await this._createDrive(publicKey, info, opts)
    else if (type === 'seeder') {
      info.type = 'drive'
      info.instance = await this._createDrive(publicKey, info, { seeders: true, announce: false })
    } else if (type === 'list') {
      for (const r of this.resources) {
        if (r.type === type) throw new Error('Max lists limit is one')
      }
      info.instance = await this._createBee(publicKey, info, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    }

    this.resources.set(id, info)

    return info
  }

  async remove (key) {
    const release = await this.lock()
    try {
      await this._remove(key)
    } finally {
      release()
    }
  }

  async _remove (key) {
    const info = this.get(key)

    if (info.seeders) await info.seeders.destroy()
    if (info.discovery) await info.discovery.destroy()
    await info.instance.close()

    this.resources.delete(info.key)
  }

  has (key) {
    const id = HypercoreId.normalize(key)
    return this.resources.has(id)
  }

  get (key) {
    const id = HypercoreId.normalize(key)
    const info = this.resources.get(id)
    if (!info) throw new Error('Resource does not exists')
    return info
  }

  filter (onfilter) {
    const arr = []
    for (const [, info] of this.resources) {
      if (onfilter(info)) arr.push(info)
    }
    return arr
  }

  async _createCore (publicKey, info, opts = {}) {
    const core = this.store.get(publicKey)
    await core.ready()

    this._suitCore(core, info, opts)

    return core
  }

  async _createBee (publicKey, info, opts = {}) {
    const core = this.store.get(publicKey)
    const bee = new Hyperbee(core, { keyEncoding: opts.keyEncoding, valueEncoding: opts.valueEncoding })
    await bee.ready()

    this._suitCore(bee.core, info, opts)

    return bee
  }

  async _createDrive (publicKey, info, opts = {}) {
    const drive = new Hyperdrive(this.store, publicKey)
    await drive.ready()

    this._suitCore(drive.core, info, opts)

    const onblobs = (blobs) => this._suitCore(blobs.core, info, opts)
    if (drive.blobs) onblobs(drive.blobs)
    else drive.once('blobs', onblobs)

    if (opts.seeders) {
      info.seeders = await this._createSeeders(publicKey)
    }

    return drive
  }

  async _createSeeders (publicKey) {
    const id = HypercoreId.encode(publicKey)
    const keyPair = await this.store.createKeyPair('simple-seeder-swarm@' + id)

    const sw = new Seeders(publicKey, { dht: this.swarm.dht, keyPair })
    sw.join()
    sw.on('connection', (socket) => this.store.replicate(socket))

    /* sw.on('update', function (record) {
      // TODO: better tracking here
      // tracking.notifs[id] = record
    }) */

    // const unregister = goodbye(() => sw.destroy())
    // sw.on('close', () => unregister())

    return sw
  }

  _suitCore (core, info, opts) {
    followSpeed(core, info)
    if (opts.announce !== false) this._swarmCore(core, info)
    core.download()
  }

  _swarmCore (core, info) {
    const done = core.findingPeers()
    info.discovery = this.swarm.join(core.discoveryKey, { client: true, server: !this.backup })
    this.swarm.flush().then(done, done)
  }
}

function followSpeed (core, info) {
  core.on('download', onspeed.bind(null, 'down', info))
  core.on('upload', onspeed.bind(null, 'up', info))
}

function onspeed (eventName, info, index, byteLength, from) {
  info.blocks[eventName](1)
  info.network[eventName](byteLength)
}
