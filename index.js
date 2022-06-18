#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbundle = require('hyperbundle')
const HypercoreId = require('hypercore-id-encoding')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    bundle: 'b',
  }
})

const store = new Corestore('./corestore')
const swarm = new Hyperswarm()

const keys = [].concat(argv.key || [])
const bundles = [].concat(argv.bundle || [])

swarm.on('connection', function (socket) {
  const p = socket.remotePublicKey.toString('hex')

  console.log('Connection opened', p)
  store.replicate(socket)
  socket.on('error', function (err) {
    console.log(err)
  })
  socket.on('close', function () {
    console.log('Connection closed', p)
  })
})

for (const key of keys) {
  downloadCore(key)
}
for (const key of bundles) {
  downloadBundle(key)
}

async function downloadBundle (key) {
  const bundle = new Hyperbundle(store, HypercoreId.decode(key))
  await bundle.ready()
  const bundleId = HypercoreId.encode(HypercoreId.decode(key))
  console.log('downloading bundle', bundleId)

  downloadCore(bundle.core)
  bundle.on('blobs', blobs => downloadCore(blobs.core, bundleId))

  swarm.join(bundle.core.discoveryKey)
}

async function downloadCore (core, bundleId) {
  core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core 
  await core.ready()
  const id = HypercoreId.encode(core.key)
  console.log('downloading core', id)

  core.download()

  core.on('download', function (index) {
    const bundleDataTag = bundleId ? 'with bundle ' + bundleId : ''
    console.log('downloaded block', index, 'from', id, bundleDataTag)
  })
}

goodbye(() => swarm.destroy())
