// Refuses to publish while the SDK dependency still points at the local folder.
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const spec = pkg.dependencies?.['@ohmyproduct/sdk']
if (!spec || spec.startsWith('file:') || spec.startsWith('link:')) {
  console.error(
    `Refusing to publish: @ohmyproduct/sdk is "${spec}". Publish the SDK first, then run:\n` +
      '  npm pkg set dependencies.@ohmyproduct/sdk=^0.1.0',
  )
  process.exit(1)
}
console.log(`SDK dependency OK (${spec}).`)
