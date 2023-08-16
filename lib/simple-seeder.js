const Hyperbee = require('hyperbee')
const Hyperdrive = require('hyperdrive')
const Seeders = require('@hyperswarm/seeders')
const speedometer = require('speedometer')
const Id = require('hypercore-id-encoding')
const mutexify = require('mutexify/promise')
const SeedBee = require('seedbee')
const { contentEncoding, metadataEncoding } = require('seedbee/encoding')

const ALLOWED_PEERS = 'simple-seeder/allowed-peers'
const SWARM_PUBLIC_KEY = 'simple-seeder/swarm-public-key'

module.exports = class SimpleSeeder {
  constructor (store, swarm, opts = {}) {
    this.corestore = store
    this.store = store.session({ writable: false })
    this.swarm = swarm

    this.backup = opts.backup === true
    this.onupdate = opts.onupdate || noop

    this.lock = mutexify()
    this.resources = new Map()

    this.destroying = false
  }

  async add (key, opts) {
    const release = await this.lock()
    try {
      return await this._add(key, opts)
    } finally {
      release()
    }
  }

  async _add (key, opts) {
    if (this.destroying) return
    if (this.has(key)) throw new Error('Resource already added')

    const publicKey = Id.decode(key)
    const id = Id.encode(publicKey)

    // Maybe all this belongs to a "Resource" class, including the internals _createCore/Bee/etc
    const info = {
      key: id,
      publicKey,
      type: opts.type,
      instance: null,
      userData: {},
      description: opts.description || null,
      seeders: null,
      discovery: null,
      blocks: { down: speedometer(), up: speedometer() },
      network: { down: speedometer(), up: speedometer() },
      external: opts.external !== false
    }

    if (opts.type === 'core') info.instance = await this._createCore(publicKey, info, opts)
    else if (opts.type === 'bee') info.instance = await this._createBee(publicKey, info, opts)
    else if (opts.type === 'drive') info.instance = await this._createDrive(publicKey, info, opts)
    else if (opts.type === 'list') info.instance = await this._createList(publicKey, info, opts)
    else if (opts.type === 'seeders') {
      info.type = 'drive'
      info.instance = await this._createDrive(publicKey, info, { seeders: true })
    } else throw new Error('Type is required')

    this.resources.set(id, info)

    return info
  }

  async put (key, opts) {
    const release = await this.lock()
    try {
      return await this._put(key, opts)
    } finally {
      release()
    }
  }

  async _put (key, opts) {
    if (this.destroying) return
    if (!this.has(key)) return this._add(key, opts)

    const info = this.get(key)

    if (info.type !== opts.type) {
      await this._remove(key)
      return this._add(key, opts)
    }

    if (!!info.seeders !== !!opts.seeders) {
      if (opts.seeders) {
        if (info.seeders) throw new Error('Seeders was already enabled') // Should not happen
        const publicKey = Id.decode(info.key)
        info.seeders = await this._createSeeders(publicKey)
      } else {
        await info.seeders.destroy()
        info.seeders = null
      }
    }

    info.description = opts.description || null

    return info
  }

  async remove (key) {
    const release = await this.lock()
    try {
      return await this._remove(key)
    } finally {
      release()
    }
  }

  async _remove (key, force) {
    if (this.destroying && !force) return

    const info = this.get(key)

    if (info.seeders) await info.seeders.destroy()
    if (info.discovery) await info.discovery.destroy()
    await info.instance.close()

    this.resources.delete(info.key)
  }

  has (key) {
    const id = Id.normalize(key)
    return this.resources.has(id)
  }

  get (key) {
    const id = Id.normalize(key)
    const info = this.resources.get(id)
    if (!info) throw new Error('Resource does not exists')
    return info
  }

  filter (onfilter) {
    return [...this.values()].filter(onfilter)
  }

  values () {
    return this.resources.values()
  }

  async update (info, list) {
    if (this.destroying) return

    const snap = list.bee.snapshot()

    try {
      for (const info of this.values()) {
        if (info.external) continue // List does not control resources from args or file, including itself

        if (await snap.get(info.publicKey) === null) {
          await this.remove(info.key)
        }
      }

      const entry = await snap.get(ALLOWED_PEERS, metadataEncoding)
      info.userData.allowedPeers = entry ? entry.value : null

      for await (const e of snap.createReadStream(contentEncoding)) {
        if (e.value.type === 'list') continue // List of lists is not supported

        await this.put(e.key, { ...e.value, external: false })
      }

      this.onupdate()
    } finally {
      await snap.close()
    }
  }

  async destroy () {
    if (this.destroying) return
    this.destroying = true

    const release = await this.lock()
    try {
      return await this._destroy()
    } finally {
      release()
    }
  }

  async _destroy () {
    const closing = []
    for (const info of this.values()) {
      closing.push(this._remove(info.key, true))
    }
    await Promise.all(closing)

    await this.store.close()
    await this.corestore.close()
  }

  async _createCore (publicKey, info, opts = {}) {
    const core = this.store.get(publicKey)
    await core.ready()

    this._suitCore(core, info)

    if (opts.seeders) info.seeders = await this._createSeeders(publicKey)

    return core
  }

  async _createBee (publicKey, info, opts = {}, enc = {}) {
    const core = this.store.get(publicKey)
    const bee = new Hyperbee(core, { keyEncoding: enc.keyEncoding, valueEncoding: enc.valueEncoding })
    await bee.ready()

    this._suitCore(bee.core, info)

    if (opts.seeders) info.seeders = await this._createSeeders(publicKey)

    return bee
  }

  async _createDrive (publicKey, info, opts = {}) {
    const drive = new Hyperdrive(this.store.session(), publicKey)
    await drive.ready()

    this._suitCore(drive.core, info)

    const onblobs = (blobs) => this._suitCore(blobs.core, info)
    if (drive.blobs) onblobs(drive.blobs)
    else drive.once('blobs', onblobs)

    if (opts.seeders) info.seeders = await this._createSeeders(publicKey)

    return drive
  }

  async _createList (publicKey, info, opts = {}) {
    const core = this.store.get(publicKey)
    const list = new SeedBee(core)
    await list.ready()

    this._suitCore(list.core, info)

    if (opts.seeders) info.seeders = await this._createSeeders(publicKey)

    const allowedPeers = await list.metadata.get(ALLOWED_PEERS)
    const swarmPublicKey = await list.metadata.get(SWARM_PUBLIC_KEY)
    info.userData.allowedPeers = allowedPeers
    info.userData.swarmPublicKey = swarmPublicKey

    return list
  }

  async _createSeeders (publicKey) {
    const id = Id.encode(publicKey)
    const keyPair = await this.store.createKeyPair('simple-seeder-swarm@' + id)

    const sw = new Seeders(publicKey, { dht: this.swarm.dht, keyPair })
    sw.join()
    sw.on('connection', (socket) => this.store.replicate(socket))

    return sw
  }

  _suitCore (core, info) {
    core.on('download', onspeed.bind(null, 'down', info))
    core.on('upload', onspeed.bind(null, 'up', info))
    this._swarmCore(core, info)
    core.download()
  }

  _swarmCore (core, info) {
    const done = core.findingPeers()
    info.discovery = this.swarm.join(core.discoveryKey, { client: true, server: !this.backup })
    this.swarm.flush().then(done, done)
  }
}

function onspeed (eventName, info, index, byteLength, from) {
  info.blocks[eventName](1)
  info.network[eventName](byteLength)
}

function noop () {}
