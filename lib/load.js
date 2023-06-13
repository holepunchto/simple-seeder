const fs = require('fs')
const Id = require('hypercore-id-encoding')
const configs = require('tiny-configs')

module.exports = async function load (argv) {
  const seeds = []
  const addSeed = (key, type) => seeds.push({ key: Id.normalize(key), type })

  if (argv.file) {
    console.log('Loading seeds from file\n')

    const file = await fs.promises.readFile(argv.file)
    const group = configs.parse(file, { split: ' ', length: 2 })
    for (const [type, key] of group) {
      if (type === 'list') throw new Error('List type is not supported in file')
      addSeed(key, type)
    }

    return seeds
  }

  if (argv._[0]) {
    console.log('Loading seeds from list\n')

    addSeed(argv._[0], 'list')

    return seeds
  }

  console.log('Loading seeds from args\n')

  for (const type of ['core', 'bee', 'drive', 'seeders']) {
    const group = [].concat(argv[type] || [])
    for (const key of group) addSeed(key, type)
  }

  return seeds
}
