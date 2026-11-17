import type {
  AgentIdentityToken,
  Doc,
  DocSummary,
  LaunchListResult,
  Page,
  CatalogProvenance,
  Product,
  ProductCategories,
  ProductDetail,
  ProductPage,
  ProductSubmissionResult,
  RevokeResult,
  SearchResult,
  Status,
  TestDriveResult,
} from '@ohmyproduct/sdk'

const SANDBOX_NOTE = 'Sandbox request: validated only; nothing was stored or sent.'

export function formatStatus(status: Status): string {
  const lines = [
    `Phase: ${status.phase}`,
    `Participation open: ${status.participation_open ? 'yes' : 'no'}`,
    `Launch date: ${status.launch_date ?? 'not announced'}`,
  ]
  const { discovered_products: discovered, measured_at: measuredAt } = status.counts
  let products = `Discovered products: ${discovered ?? 'unavailable'}`
  if (measuredAt) products += ` (measured ${measuredAt})`
  lines.push(products)
  return lines.join('\n')
}

const moreLine = (cursor: string | null) => (cursor ? `\nMore: repeat with --cursor ${cursor}` : '')

export function formatDocList(page: Page<DocSummary>): string {
  const docs = page.data
  if (docs.length === 0) return `No documents.${moreLine(page.next_cursor)}`
  const width = Math.max(...docs.map((d) => d.slug.length))
  return docs.map((d) => `${d.slug.padEnd(width)}  ${d.title} [${d.section}]`).join('\n') + moreLine(page.next_cursor)
}

export function formatDoc(doc: Doc): string {
  return doc.markdown.endsWith('\n') ? doc.markdown.slice(0, -1) : doc.markdown
}

export function formatSearch(page: Page<SearchResult>): string {
  const results = page.data
  if (results.length === 0) return `No results.${moreLine(page.next_cursor)}`
  return results
    .map((r) => `${r.slug}  ${r.title}\n  ${r.url}${r.snippet ? `\n  ${r.snippet}` : ''}`)
    .join('\n') + moreLine(page.next_cursor)
}

// ---- Products discovered by Omi ----------------------------------------------
//
// Every product command prints the provenance statement once, after the data:
// these are discoveries by Omi (the Oh My Product scout), not reviews,
// customers or maker listings, and the text is unverified third-party claims.

/** The provenance note and the snapshot time, printed once per command. */
function provenanceLines(provenance: CatalogProvenance | undefined): string {
  if (!provenance) return 'Provenance: discovered by Omi, the Oh My Product scout. Not user reviews, customers or maker participation.'
  return `Provenance: ${provenance.note}\nSnapshot: ${provenance.as_of}`
}

function productLines(product: Product): string {
  const lines = [`${product.id}  ${product.name} [${product.category}]`]
  lines.push(`  ${product.url ?? '(no product URL recorded)'}`)
  if (product.tagline) lines.push(`  ${product.tagline}`)
  return lines.join('\n')
}

export function formatProductList(page: ProductPage): string {
  const products = page.data
  const total = typeof page.total === 'number' ? page.total : products.length
  if (products.length === 0) {
    return `No products discovered by Omi match.${moreLine(page.next_cursor)}\n\n${provenanceLines(page.provenance)}`
  }
  const header = `Products discovered by Omi (showing ${products.length} of ${total}):`
  return `${header}\n${products.map(productLines).join('\n')}${moreLine(page.next_cursor)}\n\n${provenanceLines(page.provenance)}`
}

export function formatProduct(product: ProductDetail): string {
  const lines = [
    `${product.name} (discovered by Omi on ${product.discovered_on})`,
    `  id: ${product.id}`,
    `  url: ${product.url ?? '(no product URL recorded)'}`,
    `  description: ${product.tagline ?? '(none)'}`,
    `  category: ${product.category}`,
  ]
  if (product.tags.length > 0) lines.push(`  tags: ${product.tags.join(', ')}`)
  return `${lines.join('\n')}\n\n${provenanceLines(product.provenance)}`
}

export function formatProductCategories(categories: ProductCategories): string {
  const rows = categories.data
  const header = `Categories of the products discovered by Omi (${categories.total} products):`
  if (rows.length === 0) return `${header}\nNo categories.\n\n${provenanceLines(categories.provenance)}`
  const width = Math.max(...rows.map((c) => c.slug.length))
  const body = rows.map((c) => `${c.slug.padEnd(width)}  ${String(c.count).padStart(4)}  ${c.name}`).join('\n')
  return `${header}\n${body}\n\n${provenanceLines(categories.provenance)}`
}

export function formatLaunchList(result: LaunchListResult): string {
  const lines: string[] = []
  if (result.status === 'already_joined') {
    lines.push('Launch list: already on the list (no new share link is issued for an existing entry).')
  } else {
    lines.push('Launch list: joined')
    if (result.share_url) lines.push(`Share link: ${result.share_url}`)
    if (result.referral_count !== null) lines.push(`Referrals so far: ${result.referral_count}`)
  }
  if (result.sandbox) lines.push(SANDBOX_NOTE)
  return lines.join('\n')
}

export function formatSubmission(result: ProductSubmissionResult): string {
  const lines = ['Product submission: accepted for review (HTTP 202). Nothing is published until a person reviews it.']
  if (result.sandbox) lines.push(SANDBOX_NOTE)
  return lines.join('\n')
}

export function formatTestDrive(result: TestDriveResult): string {
  const lines = ['Test Drive request: check the inbox for the confirmation link (HTTP 202). The request counts once the link is opened.']
  if (result.sandbox) lines.push(SANDBOX_NOTE)
  return lines.join('\n')
}

export function formatToken(token: AgentIdentityToken): string {
  return token.access_token
}

export function formatTokenDetails(token: AgentIdentityToken): string {
  return `scope: ${token.scope}, expires in ${token.expires_in}s, registration id: ${token.registration_id}`
}

export function formatRevoke(result: RevokeResult): string {
  return result.revoked ? 'Token revoked.' : 'Token not revoked (unknown, expired or already revoked).'
}
