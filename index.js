#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')
const fs = require('fs')
const configs = require('tiny-configs')
const crayon = require('tiny-crayon')
const byteSize = require('tiny-byte-size')
const DHT = require('hyperdht')
const debounceify = require('debounceify')
const SimpleSeeder = require('./lib/simple-seeder.js')
const menu = require('./menu.js')

const argv = minimist(process.argv.slice(2), {
  alias: {
    core: 'c',
    bee: 'b',
    drive: 'd',
    seeder: 's',
    list: 'l'
  }
})

const secretKey = argv['secret-key']
const store = new Corestore(argv.storage || './corestore')

let swarm = null
let tracker = null
let stdout = ''
const notifs = {} // TODO: seeders notifications (should be in lib)

main().catch(err => {
  console.error(err)
  process.exit(1)
})

async function main () {
  if (argv.menu) {
    await menu(argv.menu, { store })
    return
  }

  swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm'),
    dht: new DHT({ port: argv.port })
  })
  goodbye(() => swarm.destroy())

  swarm.on('connection', onsocket)
  swarm.listen()

  tracker = new SimpleSeeder(store, swarm)
  const seeds = []

  for (const type of ['drive', 'seeder', 'bee', 'core', 'list']) {
    const group = [].concat(argv[type] || [])
    for (const key of group) seeds.push({ key: HypercoreId.normalize(key), type })
  }

  if (argv.file) {
    const file = await fs.promises.readFile(argv.file)
    const group = configs.parse(file, { split: ' ', length: 2 })
    for (const [type, key] of group) seeds.push({ key: HypercoreId.normalize(key), type })
  }

  for (const { key, type } of seeds) {
    if (type === 'seeder' && seeds.find(s => s.type === 'drive' && s.key === key)) continue
    const seeders = !!(type === 'drive' && seeds.find(s => s.type === 'seeder' && s.key === key))

    await tracker.add(key, type, { seeders })
  }

  const intervalId = setInterval(ui, argv.i || 5000)
  goodbye(() => clearInterval(intervalId)) // Explicit cleanup
  ui()

  const resource = tracker.find(r => r.type === 'list')
  if (resource && !argv['dry-run']) {
    const list = resource.instance
    // TODO: catch errors somewhere
    const debounced = debounceify(update.bind(null, tracker, list))
    list.core.on('append', debounced)
    await debounced()
  }
}

async function update (tracker, list) {
  for (const [, info] of tracker.resources) {
    if (!info.source) continue // List does not control resources from argv or file

    if (await list.get(info.key) === null) {
      // console.log('Update (remove)', info.key)
      await tracker.remove(info.key)
    }
  }

  for await (const e of list.createReadStream()) {
    if (tracker.has(e.key)) {
      // console.log('Update (change)', e.key)
      // const info = tracker.get(e.key)
      // TODO: check if seeders changed, announce, etc
      continue
    }

    // console.log('Update (add)', e.key)
    await tracker.add(e.key, e.value.type, { seeders: e.value.seeder, source: 'list' })
  }
}

function ui () {
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

  const cores = tracker.getByType('core')
  const bees = tracker.getByType('bee')
  const drives = tracker.getByType('drive')
  const seeders = drives.filter(r => !!r.seeders)
  const lists = tracker.getByType('list')

  if (lists.length) {
    print('Lists')
    for (const { instance: bee, blocks, network } of lists) {
      // TODO: disable byte size?
      output += formatResource(bee.core, null, { blocks, network })
    }
    print()
  }

  if (seeders.length) {
    print('Seeders')
    for (const { seeders: sw } of seeders) {
      const seedId = HypercoreId.encode(sw.seedKeyPair.publicKey)
      const notif = notifs[seedId]

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
    for (const { instance: core, blocks, network } of cores) {
      output += formatResource(core, null, { blocks, network })
    }
    print()
  }

  if (bees.length) {
    print('Bees')
    for (const { instance: bee, blocks, network } of bees) {
      output += formatResource(bee.core, null, { blocks, network })
    }
    print()
  }

  if (drives.length) {
    print('Drives')
    for (const { instance: drive, blocks, network } of drives) {
      output += formatResource(drive.core, drive.blobs, { blocks, network, isDrive: true })
    }
    print()
  }

  if (output === stdout) return
  stdout = output

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
    crayon.green('↓') + ' ' + crayon.yellow(Math.ceil(blocks.down())),
    crayon.cyan('↑') + ' ' + crayon.yellow(Math.ceil(blocks.up())) + ' blks/s',
    crayon.green('↓') + ' ' + crayon.yellow(byteSize(network.down())),
    crayon.cyan('↑') + ' ' + crayon.yellow(byteSize(network.up()))
  )
}

function format (...args) {
  return args.join(' ') + '\n'
}

function onsocket (socket) {
  store.replicate(socket)
}
