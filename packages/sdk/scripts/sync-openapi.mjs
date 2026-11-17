// Refreshes openapi.snapshot.json from the live OpenAPI document.
//
//   npm run sync:openapi                      # https://ohmyproduct.com/openapi.json
//   OMP_OPENAPI_SOURCE=https://example.test/openapi.json npm run sync:openapi   # another URL
//   OMP_OPENAPI_SOURCE=./some/openapi.json npm run sync:openapi   # local file
//
// Then run `npm test`: the contract test fails if the SDK no longer matches.
import { readFileSync, writeFileSync } from 'node:fs'

const source = process.env.OMP_OPENAPI_SOURCE ?? 'https://ohmyproduct.com/openapi.json'
const target = new URL('../openapi.snapshot.json', import.meta.url)

let text
if (/^https?:\/\//.test(source)) {
  const response = await fetch(source, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    console.error(`sync:openapi: ${source} answered HTTP ${response.status}`)
    process.exit(1)
  }
  text = await response.text()
} else {
  text = readFileSync(source, 'utf8')
}

const document = JSON.parse(text)
if (!document.openapi || !document.paths) {
  console.error('sync:openapi: the source is not an OpenAPI document.')
  process.exit(1)
}
writeFileSync(target, JSON.stringify(document, null, 2) + '\n')
// Path items may also carry `servers` (the /agent/* endpoints); count HTTP methods only.
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
const count = Object.values(document.paths).reduce((n, item) => n + Object.keys(item).filter((k) => METHODS.has(k)).length, 0)
console.log(`Wrote openapi.snapshot.json (${count} operations, API version ${document.info?.version}).`)
