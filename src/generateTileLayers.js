const argv = require('minimist')(process.argv.slice(2))
const path = require('path')
const untildify = require('untildify')
const fs = require('fs-extra')
const _ = require('lodash/fp')

const JSON5 = require('json5')
const workerpool = require('workerpool')

const configPath = argv['_'][0]
if (!configPath) throw Error('No config specified')


const configS = fs.readFileSync(path.resolve(untildify(configPath)))
const config = JSON5.parse(configS)

const tileRegex = /r\.(-?\d+)\.(-?\d+)\.png/

const inBounds = ([x, z], [minX, maxX], [minZ, maxZ]) => x >= minX && x <= maxX && z >= minZ && z <= maxZ

const wpool = workerpool.pool(
  path.resolve(__dirname, './workers.js'),
  {
    workerType: 'thread'
  }
)

const as = async () => {
  const processMap = async (mapOpts) => {
    const tileDir = path.resolve(mapOpts.dir)
    const outputDir = path.resolve(mapOpts.outputDir)
    const z0dir = path.resolve(outputDir, 'z.0')
    fs.mkdirSync(z0dir, { recursive: true })
    const files = fs.readdirSync(tileDir)
      .map(name => {
        const match = tileRegex.exec(name)
        let x,z
        try {
          x = parseInt(match[1])
          z = parseInt(match[2])
        } catch (e) { return null }
        const fpath = path.resolve(tileDir, name)
        const outputPath = path.resolve(z0dir, name)
        const mtime = fs.statSync(fpath).mtime
  
        let shouldUpdate = false
        try {
          const outStat = fs.statSync(outputPath)
          if (mtime > outStat.mtime) shouldUpdate = true // file changed
        } catch (err) {
          shouldUpdate = true // file doesn't exist
        }
  
        return {
          name,
          path: fpath,
          shouldUpdate,
          outputPath,
          coord: [x, z],
        }
      })
      .filter(res =>
        Boolean(res)
        && inBounds(res.coord, mapOpts.bounds.x, mapOpts.bounds.z)
      )
    
      const regionCoords = files.map(f => f.coord)
      const rp = {
        minX: _.minBy(0)(regionCoords)[0],
        maxX: _.maxBy(0)(regionCoords)[0],
        minZ: _.minBy(1)(regionCoords)[1],
        maxZ: _.maxBy(1)(regionCoords)[1],
        // coords: regionCoords,
      }

      // const findMidpoint = _.flow(
      //   (min, max) => Math.trunc((min + max) / 2),
      //   mid => mid - mid % 2
      // )
        
      // const midCoord = [
      //   findMidpoint(rp.minX, rp.maxX),
      //   findMidpoint(rp.minZ, rp.maxZ)
      // ]

      const maxSpan = Math.max(rp.maxX - rp.minX, rp.maxZ - rp.minZ)
      const minZoom = -Math.trunc((Math.log(maxSpan) / Math.log(2)))

      const filesToUpdate = files.filter(f => f.shouldUpdate)
    
      if (!filesToUpdate.length) {
        return console.log(`No tiles to update for ${mapOpts.name}`)
      }

      await Promise.all(filesToUpdate.map(f =>
          wpool.exec('compressFile', [f.path, f.outputPath])
            .then(() => console.log(`${mapOpts.name}, z.0: ${f.name}`))
        ))
      
      const generateZoomLevel = async (
        tileCoords,
        zoom,
      ) => {
        if (zoom < minZoom) return
        const zoomFolder = path.join(outputDir, `z.${zoom}`)
        const prevFolder = path.join(outputDir, `z.${zoom + 1}`)
        if (!fs.existsSync(zoomFolder)) fs.mkdirSync(zoomFolder)

        const tileData = _.flow(
          _.map((tilePoint) => {
            const [x, z] = tilePoint.map(c => c - Math.abs(c % 2))
            return {
              quadPoints: [[x,z],[x+1,z],[x,z+1],[x+1,z+1]].map(point => ({
                point,
                path: path.resolve(prevFolder, `r.${point[0]}.${point[1]}.png`),
              })),
              outPath: path.resolve(zoomFolder, `r.${x/2}.${z/2}.png`),
              outPoint: [x/2,z/2],
            }
          }),
          _.uniqBy('outPath')
        )(tileCoords)
        
        await Promise.all(tileData.map(t =>
          wpool.proxy()
            .then(worker => worker.combineTiles(t))
            .catch(err => { console.warn(`Problem on ${mapOpts.name}, zoom: ${zoom}, tile: ${t.outPoint}`, err) })
            .then(() => console.log(`${mapOpts.name}, z.${zoom}: ${t.quadPoints[0].point.map(c => c/2)}`))))
    
        await generateZoomLevel(tileData.map(t => t.outPoint), zoom - 1)
      }

      
      await generateZoomLevel(filesToUpdate.map(f => f.coord), -1)
      
      const props = {
        mapName: mapOpts.name,
        dimension: mapOpts.dimension,
        tileSize: 512,
        maxZoom: 0,
        minZoom: minZoom,
        regions: rp,
      }
      fs.writeFileSync(path.join(outputDir, 'tile.properties.json'), JSON.stringify(props))
      console.log(`${mapOpts.name} tiles completed`)
  }
  await Promise.all(config.maps.map(processMap))
  wpool.terminate()
}

as()
