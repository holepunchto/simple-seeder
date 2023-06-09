# simple-seeder

Dead simple Hypercore seeder

```
npm install -g simple-seeder
```

## Usage

```
simple-seeder -c <hypercore key> -c <hypercore key 2>
```

Three ways to load seeds, you can only use one per process.

## Args
You use those args:

```
--core, -c <key>
--bee, -b <key>
--drive, -d <key>
--seeder, -s <key>
```

The `seeder` option is only for drives, and must use the same drive key to enable it.

## File
A file containing the seeds list:

```
simple-seeder --file ./seeds.txt
```

`seeds.txt`
```
core <hypercore key>
bee <hyperbee key>
drive <hyperdrive key>
seeder <hyperdrive key>
```

## List
A Hyperbee list that can receive updates in real-time.

Manage the list with `simple-seeder --menu`.

The menu will also show you the Hyperbee list key that you can use:
```
simple-seeder --list <hyperbee list key>
```

In the menu you can generate more list keys, so you can manage different lists:
`simple-seeder --menu <key>`

## License

Apache-2.0
