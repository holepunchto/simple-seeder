#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const HypercoreId = require('hypercore-id-encoding')
const Seeders = require('@hyperswarm/seeders')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')
const fsp = require('fs/promises')
const configs = require('tiny-configs')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    bee: 'bee',
    bundle: 'b',
    seeder: 's',
    drive: 'b',
    d: 'b'
  }
})

start().catch(err => {
  console.error(err)
  process.exit(1)
})

async function start () {
  const secretKey = argv['secret-key']
  const store = new Corestore(argv.storage || './corestore')
  const swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm')
  })

  console.log('Starting with with public key', HypercoreId.encode(swarm.keyPair.publicKey))

  const keys = [].concat(argv.key || [])
  const bees = [].concat(argv.bee || [])
  const drives = [].concat(argv.drive || [])
  const seeders = [].concat(argv.seeder || [])

  if (argv.file) {
    const seeds = await fsp.readFile(argv.file)
    for (const [type, key] of configs.parse(seeds, { split: ' ', length: 2 })) {
      if (type === 'key') keys.push(key)
      else if (type === 'bee') bees.push(key)
      else if (type === 'bundle' || type === 'drive') drives.push(key)
      else if (type === 'seeder') seeders.push(key)
      else throw new Error('Invalid seed type: ' + type)
    }
  }

  let connections = 0

  swarm.on('connection', onsocket)

  swarm.listen()

  for (const key of keys) {
    downloadCore(key)
  }

  for (const key of bees) {
    downloadBee(key)
  }

  for (const key of drives) {
    downloadDrive(key)
  }

  for (const s of seeders) {
    const publicKey = HypercoreId.decode(s)
    const id = HypercoreId.encode(publicKey)
    const keyPair = await store.createKeyPair('simple-seeder-swarm@' + id)
    const sw = new Seeders(publicKey, {
      dht: swarm.dht,
      keyPair: keyPair
    })

    console.log('Seeder swarm for ' + s + ' listening on ' + HypercoreId.encode(keyPair.publicKey))

    sw.join()
    sw.on('connection', onsocket)
    sw.on('update', function (record) {
      console.log('seeder change for ' + s + ':', record)
    })

    goodbye(() => sw.destroy())

    if (!drives.includes(s)) {
      downloadDrive(s, false)
    }
  }

  async function downloadDrive (key, announce) {
    const driveId = HypercoreId.encode(HypercoreId.decode(key))
    const drive = new Hyperdrive(store, HypercoreId.decode(key))
    drive.on('blobs', blobs => downloadCore(blobs.core, driveId, false))
    console.log('downloading drive', driveId)
    downloadBee(drive.core, announce)
  }

  async function downloadBee (core, announce) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

    const bee = new Hyperbee(core)
    await bee.ready()

    downloadCore(core, null, announce, 'bee')
  }

  async function downloadCore (core, driveId, announce, name) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core
    await core.ready()
    const id = HypercoreId.encode(core.key)
    console.log('downloading', name || 'core', id)

    if (announce !== false) {
      console.log('announcing', id)
      swarm.join(core.discoveryKey)
    }
    core.download()

    core.on('download', function (index) {
      const driveDataTag = driveId ? 'with drive ' + driveId : ''
      console.log('downloaded block', index, 'from', id, driveDataTag)
    })
  }

  goodbye(() => swarm.destroy())

  function onsocket (socket) {
    const p = HypercoreId.encode(socket.remotePublicKey)

    connections++

    console.log('Connection opened', p, '(total ' + connections + ')')
    store.replicate(socket)
    socket.on('error', function (err) {
      console.log(err)
    })
    socket.on('close', function () {
      connections--
      console.log('Connection closed', p, '(total ' + connections + ')')
    })
  }

  await swarm.dht.ready()

  console.log()
  console.log('Node info:')
  console.log('- remote host:', swarm.dht.host)
  console.log('- remote port:', swarm.dht.port)
  console.log('- firewalled:', swarm.dht.firewalled)
  console.log('- nat type:', swarm.dht.port ? 'consistent' : 'random')
  console.log()
}
