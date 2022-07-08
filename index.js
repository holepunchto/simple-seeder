#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbundle = require('hyperbundle')
const HypercoreId = require('hypercore-id-encoding')
const Seeders = require('@hyperswarm/seeders')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    bundle: 'b',
    seeder: 's'
  }
})

start().catch(err => {
  console.error(err)
  process.exit(1)
})

async function start () {
  const secretKey = argv['secret-key']
  const store = new Corestore('./corestore')
  const swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm')
  })

  console.log('Starting with with public key', HypercoreId.encode(swarm.keyPair.publicKey))

  const keys = [].concat(argv.key || [])
  const bundles = [].concat(argv.bundle || [])
  const seeders = [].concat(argv.seeder || [])

  swarm.on('connection', onsocket)

  swarm.listen()

  for (const key of keys) {
    downloadCore(key)
  }
  for (const key of bundles) {
    downloadBundle(key)
  }

  for (const s of seeders) {
    const sw = new Seeders(HypercoreId.decode(s), {
      dht: swarm.dht,
      keyPair: swarm.keyPair,
      server: false
    })

    sw.join()
    sw.on('connection', onsocket)
    sw.on('update', function (record) {
      console.log('seeder change for ' + s + ':', record)
    })

    goodbye(() => sw.destroy())

    if (!bundles.includes(s)) {
      downloadBundle(s, false)
    }
  }

  async function downloadBundle (key, announce) {
    const bundleId = HypercoreId.encode(HypercoreId.decode(key))
    const bundle = new Hyperbundle(store, HypercoreId.decode(key))
    bundle.on('blobs', blobs => downloadCore(blobs.core, bundleId, false))
    console.log('downloading bundle', bundleId)
    downloadCore(bundle.core, null, announce)
  }

  async function downloadCore (core, bundleId, announce) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core
    await core.ready()
    const id = HypercoreId.encode(core.key)
    console.log('downloading core', id)

    if (announce !== false) swarm.join(core.discoveryKey)
    core.download()

    core.on('download', function (index) {
      const bundleDataTag = bundleId ? 'with bundle ' + bundleId : ''
      console.log('downloaded block', index, 'from', id, bundleDataTag)
    })
  }

  goodbye(() => swarm.destroy())

  function onsocket (socket) {
    const p = socket.remotePublicKey.toString('hex')

    console.log('Connection opened', p)
    store.replicate(socket)
    socket.on('error', function (err) {
      console.log(err)
    })
    socket.on('close', function () {
      console.log('Connection closed', p)
    })
  }
}
