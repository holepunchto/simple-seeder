#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const HypercoreId = require('hypercore-id-encoding')
const Seeders = require('@hyperswarm/seeders')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')
const fs = require('fs')
const configs = require('tiny-configs')
const crayon = require('tiny-crayon')
const byteSize = require('tiny-byte-size')
const DHT = require('hyperdht')
const Tracker = require('./lib/tracker.js')
const menu = require('./menu.js')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    core: 'c',
    bee: 'b',
    drive: 'd',
    seeder: 's',
    list: 'l'
  }
})

// const types = ['core', 'bee', 'drive', 'seeder']
const tracker = new Tracker()
const tracking = { // TODO: delete this
  intervalId: null,
  output: '',
  notifs: {},
  swarm: null,
  resources: []
}

const secretKey = argv['secret-key']
const store = new Corestore(argv.storage || './corestore')

let swarm = null

main().catch(err => {
  console.error(err)
  process.exit(1)
})

async function main () {
  if (argv.menu) {
    await menu(argv.menu, { store })
    return
  }

  const dht = new DHT({ port: argv.port })
  swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm'),
    dht
  })
  goodbye(() => swarm.destroy())

  tracking.swarm = swarm

  swarm.on('connection', onsocket)
  swarm.listen()

  // TODO: simplify
  const lists = [].concat(argv.list || [])
  const cores = [].concat(argv.core || []).concat(argv.key || [])
  const bees = [].concat(argv.bee || [])
  const drives = [].concat(argv.drive || [])
  const seeders = [].concat(argv.seeder || [])

  if (argv.file) {
    const file = await fs.promises.readFile(argv.file)
    const list = configs.parse(file, { split: ' ', length: 2 })

    for (const [type, key] of list) {
      if (type === 'list') lists.push(key)
      else if (type === 'core' || type === 'key') cores.push(key)
      else if (type === 'bee') bees.push(key)
      else if (type === 'drive') drives.push(key)
      else if (type === 'seeder') seeders.push(key)
      else throw new Error('Invalid seed type: ' + type + ' for ' + key)
    }
  }

  // TODO: dedup keys, in case having too many external lists where there are more chances to repeat resources
  for (const key of cores) await downloadCore(key)
  for (const key of bees) await downloadBee(key)
  for (const key of drives) await downloadDrive(key)
  for (const key of seeders) await downloadSeeder(key, { drives })
  for (const key of lists) await downloadLists(key)

  // TODO: use lists watcher to add/remove resources from tracker
  watcher() // TODO: safety catch

  tracking.intervalId = setInterval(update, argv.i || 5000)
  update()
}

async function downloadCore (core, announce, { track = true, parent = null } = {}) {
  core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

  await core.ready()

  if (track) tracker.add('core', core, { speedometer: core })

  if (announce !== false) {
    const done = core.findingPeers()
    swarm.join(core.discoveryKey, { client: true, server: !argv.backup })
    swarm.flush().then(done, done)
  }

  core.download()
}

async function downloadBee (core, announce, { track = true, watch = false } = {}) {
  core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core

  const bee = new Hyperbee(core)
  const watcher = watch ? bee.watch() : null
  await bee.ready()

  if (track) tracker.add('bee', bee, { speedometer: bee.core })

  await downloadCore(core, announce, { track: false, parent: bee })

  return { bee, watcher }
}

async function downloadDrive (key, announce) {
  const drive = new Hyperdrive(store, HypercoreId.decode(key))
  await drive.ready()

  const info = tracker.add('drive', drive, { speedometer: drive.core })
  if (drive.blobs) Tracker.speedometer(drive.blobs.core, info)
  else drive.on('blobs', blobs => Tracker.speedometer(blobs.core, info))

  downloadBee(drive.core, announce, { track: false })
  if (drive.blobs) downloadCore(drive.blobs.core, false, { track: false, parent: drive })
  else drive.on('blobs', blobs => downloadCore(blobs.core, false, { track: false, parent: drive }))
}

async function downloadSeeder (key, { drives }) {
  const publicKey = HypercoreId.decode(key)
  const id = HypercoreId.encode(publicKey)
  const keyPair = await store.createKeyPair('simple-seeder-swarm@' + id)
  const sw = new Seeders(publicKey, { dht: swarm.dht, keyPair })

  tracker.add('seeder', sw)

  sw.join()
  sw.on('connection', onsocket)
  sw.on('update', function (record) {
    tracking.notifs[id] = record
  })

  const unregister = goodbye(() => sw.destroy())
  sw.on('close', () => unregister())

  if (!drives.includes(key)) {
    await downloadDrive(key, false)
  }
}

async function downloadLists (core, announce) {
  const { bee, watcher } = await downloadBee(core, announce, { track: false, watch: !argv['dry-run'] })

  tracker.add('list', bee, { speedometer: bee.core, watcher })

  return bee
}

async function watcher () {
  const lists = tracker.getByType('list')
  if (!lists.length) return

  for (const { list, watcher } of lists) {
    if (!watcher) continue
    watching(list, watcher) // TODO: safety catch
  }
}

async function watching (bee, watcher) {
  /* for await (const [current] of watcher) {
    for await (const entry of current.createReadStream()) {
      const resources = tracker.getByType(entry.value.type)
      const resource = resources.find(filter(entry))

      if (!resource) {

      }

      if (resource) {
        // TODO: skip same
      }

      if (resource) {
        // Resource already exists
        // TODO: compare "entry" with "resource" to see what changed i.e. type, description, seeder enabled/disabled, etc
      } else {
        // New resource
      }
    }
  }

  function filter (entry) {
    return function (r) {
      const id = r.id || HypercoreId.encode(r.seedKeyPair.publicKey)
      return id === entry.key
    }
  } */
}

function update () {
  const { swarm } = tracking
  const { dht } = swarm

  let output = ''
  const print = (...args) => { output += args.join(' ') + '\n' }

  print('Node')
  print('- Address:', dht.bootstrapped ? crayon.yellow(dht.host + ':' + dht.port) : crayon.gray('~'))
  print('- Firewalled?', dht.bootstrapped ? (dht.firewalled ? crayon.red('Yes') : crayon.green('No')) : crayon.gray('~'))
  print('- NAT type:', dht.bootstrapped ? (dht.port ? crayon.green('Consistent') : crayon.red('Random')) : crayon.gray('~'))
  print()

  print('Swarm')
  print('- Public key:', crayon.green(HypercoreId.encode(swarm.keyPair.publicKey)))
  print('- Connections:', crayon.yellow(swarm.connections.size), swarm.connecting ? ('(connecting ' + crayon.yellow(swarm.connecting) + ')') : '')
  print()

  const lists = tracker.getByType('list')
  const seeders = tracker.getByType('seeder')
  const cores = tracker.getByType('core')
  const bees = tracker.getByType('bee')
  const drives = tracker.getByType('drive')

  if (lists.length) {
    print('Lists')
    for (const { list, blocks, network } of lists) {
      // TODO: disable byte size?
      output += formatResource(list.core, null, { blocks, network })
    }
    print()
  }

  if (seeders.length) {
    print('Seeders')
    for (const sw of seeders) {
      const seedId = HypercoreId.encode(sw.seedKeyPair.publicKey)
      const notif = tracking.notifs[seedId]

      if (!notif) {
        print('-', crayon.green(seedId), crayon.gray('~'))
        continue
      }

      print(
        '-',
        crayon.green(seedId),
        crayon.yellow(notif.seeds.length) + ' seeds,',
        crayon.yellow(notif.core.length) + ' length,',
        crayon.yellow(notif.core.fork) + ' fork'
      )
    }
    print()
  }

  if (cores.length) {
    print('Cores')
    for (const { core, blocks, network } of cores) {
      output += formatResource(core, null, { blocks, network })
    }
    print()
  }

  if (bees.length) {
    print('Bees')
    for (const { bee, blocks, network } of bees) {
      output += formatResource(bee.core, null, { blocks, network })
    }
    print()
  }

  if (drives.length) {
    print('Drives')
    for (const { drive, blocks, network } of drives) {
      output += formatResource(drive.core, drive.blobs, { blocks, network, isDrive: true })
    }
    print()
  }

  if (output === tracking.output) return
  tracking.output = output

  console.clear()
  process.stdout.write(output)
}

function formatResource (core, blobs, { blocks, network, isDrive = false } = {}) {
  const progress = [crayon.yellow(core.contiguousLength + '/' + core.length)]
  if (isDrive) progress.push(crayon.yellow((blobs?.core.contiguousLength || 0) + '/' + (blobs?.core.length || 0)))

  const byteLength = [crayon.yellow(byteSize(core.byteLength))]
  if (isDrive) byteLength.push(crayon.yellow(byteSize(blobs?.core.byteLength || 0)))

  const peers = [crayon.yellow(core.peers.length)]
  if (isDrive) peers.push(crayon.yellow(blobs?.core.peers.length || 0))

  return format(
    '-',
    crayon.green(core.id),
    progress.join(' + ') + ' blks,',
    byteLength.join(' + ') + ',',
    peers.join(' + ') + ' peers,',
    crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.download())),
    crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.upload())) + ' blks/s',
    crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.download())),
    crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.upload()))
  )
}

function format (...args) {
  return args.join(' ') + '\n'
}

function onsocket (socket) {
  store.replicate(socket)
}
