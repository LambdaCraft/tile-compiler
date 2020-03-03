const { exec, execSync, spawn } = require('child_process')
const argv = require('minimist')(process.argv.slice(2))
const path = require('path')
const untildify = require('untildify')
const fs = require('fs-extra')
const _ = require('lodash')
const Promise = require('bluebird')
const os = require('os')

const argCache = {}

const ARG = (short, long, defaultValue, explanation) => {
  const s = short ? argv[short] : null
  const l = long ? argv[long] : null
  if (s && l) throw Error(`Require only one of ${short} or ${long}`)
  argCache[`${short},${long}`] = [short, long, defaultValue, explanation]

  return s || l || defaultValue || false
}

const getUserPath = p => path.resolve(__dirname, untildify(p))

// map type -> dimension
const MAP_TYPES = {
  overworld: 'overworld',
  the_nether: 'the_nether',
  the_end: 'the_end',
}

const getMapOpts = (map) => {
  const optMap = {
    overworld: ['-c', 'OCEAN_GROUND'],
    the_nether: [`--max-height=${NETHER_HEIGHT}`],
  }
  return optMap[map] || []
}

// dimension -> paths
const DIM_DIRS = {
  overworld: ['region'],
  the_nether: ['DIM-1', 'region'],
  the_end: ['DIM1', 'region'],
}

const BLOCK_MAP_JAR = getUserPath(ARG(
  'j', 'jar', 'BlockMap-cli.jar',
  'BlockMap cli jar to use for rendering.'
))

const RENDER_MAPS = ARG(
  'm', 'maps', Object.values(MAP_TYPES).join(','),
  `Map types to render, separated by single commas.`
).split(',')

const NETHER_HEIGHT = ARG(
  null, 'nether-height', '72', 'Height cutoff for nether map'
)

const OUTPUT_FOLDER = getUserPath(ARG(
  'o', 'output', path.join(__dirname, 'tiles'), 'Output folder to place generated map tiles.'
))

const COMPRESSION = ARG(
  'c', 'compression', null, 'Compression to use for map tiles. One of MAGICK|PNGQUANT'
)

const FORCE_OVERWRITE = ARG(
  'f', '--force-overwrite', false, 'Remove any existing tile map directory that conflicts with new generation.'
)

const COMPRESSION_FLAGS = ARG(
  null, 'compression-flags',
  COMPRESSION === 'MAGICK' ?
      '-format jpg -strip -interlace Plane -quality 90% *.png'
    : COMPRESSION === 'PNGQUANT' ?
      '-f --ext .png 128 *.png' : null,
  'Flags for compression. Must be used with -c flag. MAGICK compressor is imagemagick PNGQUANT is pngquant. Defaults to 90% for JPG and 128 color for PNGQUANT.'
)


const help = ARG('h', 'help', null, 'Display help menu');

const tileRegex = /r\.(-?\d+)\.(-?\d+)\.png/

const spawnAsync = (...args) => new Promise((res, rej) => {
  const proc = spawn(...args);
  proc.stdout.pipe(process.stdout, { end: false })
  proc.stderr.pipe(process.stderr, { end: false })
  proc.on('exit', () => res())
})

const padNum = x => x > 0 ? Math.ceil(x) : Math.floor(x)

const compressDir = async (dir) => {
  if (COMPRESSION) {
    const prog = COMPRESSION === 'MAGICK' ?
        'mogrify'
      : COMPRESSION === 'PNGQUANT' ?
        'pngquant' : 'ERROR'
    try {
      if (prog === 'ERROR') throw Error('Invalid compression type')
      console.log(`Compressing images in ${dir}...`)
      await spawnAsync(`${prog} ${COMPRESSION_FLAGS}`, [], {cwd: dir, shell: true})
    } catch(error) {
      console.error(`Failed to compress with ${prog} ${COMPRESSION_FLAGS} in ${dir}: ${error}`)
    }
  }
}

const main = async () => {
  if (COMPRESSION && !COMPRESSION_FLAGS) return console.error('Require compression flags for compression option.')
  if (help) {
    console.log('Tile Layer Compiler')
    console.log('Usage: tile-compiler OPTIONS PATH_TO_WORLD_FOLDER\n')
    for (const [short, long, def, exp] of Object.values(argCache)) {
      console.log(
        (short ? `-${short}\t` : '') +
        (long ? `--${long}` : '') + '\t\t\t' +
        (exp || '') + (exp && def ? ' ' : '') +
        (def ? `Default: ${def}` : '')
      )
    }
    return
  }

  let WORLD_DIR = argv['_'][0]
  if (!WORLD_DIR) return console.error('No world dir specified')
  else WORLD_DIR = getUserPath(WORLD_DIR)

  // return console.log(WORLD_DIR, OUTPUT_FOLDER)

  for (const map of RENDER_MAPS) {
    if (!MAP_TYPES[map]) return console.error(`Map type ${MAP_TYPES[map]} does not exist`)
  }
  
  const spawns = RENDER_MAPS.map(async map => {
    const mapFolder = path.join(OUTPUT_FOLDER, map)
    const output = path.join(mapFolder, 'z.0')
    const dimension = MAP_TYPES[map]
    const regionsFolder = path.join(WORLD_DIR, ...DIM_DIRS[dimension])

    console.log(`Generating base tiles for ${map}...`)
    if (FORCE_OVERWRITE && fs.existsSync(mapFolder)) fs.removeSync(mapFolder)
    await spawnAsync('java', [
      '-jar', BLOCK_MAP_JAR,
      'render',
      '-o', output,
      ...getMapOpts(map),
      regionsFolder
    ])
    execSync(`rm ${path.join(output, 'rendered.json.gz')}`)

    const regionCoords = fs.readdirSync(output).map(file => {
      const match = tileRegex.exec(file)
      let x,z
      try {
        x = parseInt(match[1])
        z = parseInt(match[2])
      } catch (e) { return null }
      return [x, z]
    }).filter(Boolean)

    const rp = {
      minX: _.minBy(regionCoords, 0)[0],
      maxX: _.maxBy(regionCoords, 0)[0],
      minZ: _.minBy(regionCoords, 1)[1],
      maxZ: _.maxBy(regionCoords, 1)[1],
      // coords: regionCoords,
    }

    const maxSpan = Math.max(rp.maxX - rp.minX, rp.maxZ - rp.minZ)
    const minZoom = -Math.trunc((Math.log(maxSpan) / Math.log(2)))
    let iterCoords = regionCoords
    for (let zoom = -1, i = 0; zoom >= minZoom; --zoom, i++) {
      console.log(`Generating zoom level ${zoom} for map ${map}`)
      const regionCheck = {}
      iterCoords.forEach(([x, z]) => {
        if (!regionCheck[x]) regionCheck[x] = {}
        regionCheck[x][z] = true
      })
      iterCoords = []

      const newFolderPath = path.join(mapFolder, `z.${zoom}`)
      if (!fs.existsSync(newFolderPath)) fs.mkdirSync(newFolderPath)
      const zoomFactor = Math.pow(2, i)
      const [minX, maxX, minZ, maxZ] = [rp.minX, rp.maxX, rp.minZ, rp.maxZ].map(m => padNum(m / zoomFactor))
      for (let x = minX + minX%2; x <= maxX; x += 2) {
        for (let z = minZ + minZ%2; z <= maxZ; z += 2) {
          let tilePoints = [[x,z],[x+1,z],[x,z+1], [x+1,z+1]]
          tilePoints = tilePoints.map((p) => {
            if (_.get(regionCheck, p)) {
              return path.join(`z.${zoom+1}`, `r.${p[0]}.${p[1]}.png`)
            }
            return 'null:'
          })
          // if (_.every(tilePoints, s => s === 'null:')) continue
          const np = [x/2, z/2]
          execSync(`montage ${tilePoints.join(' ')} -tile 2x2 -geometry 256x256+0+0 -background transparent z.${zoom}/r.${np[0]}.${np[1]}.png`, {cwd: mapFolder, stdio: 'inherit'})
          iterCoords.push(np)
        }
      }
    }

    const compressionPaths = _.range(minZoom, 1).map(z => path.resolve(__dirname, mapFolder, `z.${z}`))
    await Promise.map(
      compressionPaths,
      compressDir,
      { concurrency: os.cpus().length }
    )

    const props = {
      mapName: map,
      dimension,
      tileSize: 512,
      maxZoom: 0,
      minZoom: minZoom,
      regions: rp,
    }
    fs.writeFileSync(path.join(mapFolder, 'tile.properties.json'), JSON.stringify(props))
    console.log(`Tiles for ${map} completed!`)
  })

  await Promise.all(spawns)
}

module.exports = main
