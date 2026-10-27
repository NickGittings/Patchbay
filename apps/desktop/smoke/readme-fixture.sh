#!/bin/sh
# The Northstar demo repo that scripts/readme-shots.mjs photographs for the README: a storefront
# with an API and a catalog library, and an "Add product search" worktree with uncommitted work
# that smoke/readme.js attaches as a task.
set -eu
dir="${TMPDIR:-/tmp}/patchbay-readme"
# The demo servers' ports, uncommon so they don't meet a real dev server's.
for port in 41730 41740; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "readme-fixture: port $port is in use; the Northstar demo servers need it free." >&2
    exit 1
  fi
done
rm -rf "$dir"
mkdir -p "$dir/northstar"
cd "$dir/northstar"
git init -q -b main
git config user.name 'Northstar'
git config user.email northstar@patchbay.invalid
git config commit.gpgsign false

mkdir -p apps/web apps/api packages/catalog docs
cat > apps/web/server.js <<'JS'
const http = require('node:http')
const fs = require('node:fs')
const server = http.createServer((_, res) => res.end(fs.readFileSync(`${__dirname}/index.html`)))
const port = Number(process.env.PORT) || 41730
server.on('error', (e) => {
  console.error(`Northstar storefront: cannot listen on port ${port}: ${e.message}`)
  process.exit(1)
})
server.listen(port, () => {
  console.log('Northstar storefront · development server\n')
  console.log(`  Local:    http://localhost:${server.address().port}`)
  console.log('  Status:   ready for product search')
})
JS
cat > apps/web/index.html <<'HTML'
<!doctype html>
<title>Northstar</title>
<h1>Northstar outfitters</h1>
<ul id="products"></ul>
<script type="module" src="./main.js"></script>
HTML
cat > apps/api/server.js <<'JS'
const http = require('node:http')
const { search } = require('../../packages/catalog/search.js')
const server = http.createServer((req, res) => {
  const query = new URL(req.url, 'http://localhost').searchParams.get('q') ?? ''
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(search(query)))
})
const port = Number(process.env.PORT) || 41740
server.on('error', (e) => {
  console.error(`Northstar API: cannot listen on port ${port}: ${e.message}`)
  process.exit(1)
})
server.listen(port, () => {
  console.log('Northstar API · development server\n')
  console.log(`  Local:    http://localhost:${server.address().port}`)
  console.log('  Catalog:  GET /products?q=trail')
  console.log('  Health:   accepting requests')
})
JS
cat > packages/catalog/products.js <<'JS'
module.exports = [
  { id: 1, name: 'Trail runner 2' },
  { id: 2, name: 'Summit shell jacket' },
  { id: 3, name: 'Ridge daypack' },
]
JS
cat > packages/catalog/search.js <<'JS'
const products = require('./products.js')

function search(query) {
  return products.filter((p) => p.name.includes(query))
}

module.exports = { search }
JS
cat > packages/catalog/search.test.js <<'JS'
const test = require('node:test')
const assert = require('node:assert')
const { search } = require('./search.js')

test('matches product names', () => {
  assert.deepStrictEqual(search('Ridge').map((p) => p.id), [3])
})
JS
cat > docs/README.md <<'MD'
# Northstar

Storefront, API and catalog for Northstar outfitters.
MD
cat > patchbay.json <<'JSON'
{
  "schemaVersion": 4,
  "name": "Northstar",
  "components": [
    {
      "id": "web",
      "name": "Web app",
      "kind": "frontend",
      "path": "apps/web",
      "notes": "Customer storefront and product search. Calls the API for catalog results.",
      "terminals": [
        {
          "id": "dev",
          "name": "Web server",
          "command": "node server.js",
          "kind": "task",
          "readyWhen": "ready for product search",
          "action": "development"
        }
      ],
      "position": { "x": 0, "y": 120 }
    },
    {
      "id": "api",
      "name": "API",
      "kind": "backend",
      "path": "apps/api",
      "notes": "HTTP API serving catalog search to the storefront.",
      "terminals": [
        {
          "id": "dev",
          "name": "API server",
          "command": "node server.js",
          "kind": "task",
          "readyWhen": "accepting requests",
          "action": "development"
        }
      ],
      "position": { "x": 360, "y": 0 }
    },
    {
      "id": "catalog",
      "name": "Catalog",
      "kind": "library",
      "path": "packages/catalog",
      "notes": "Product data and search shared by the API and the storefront.",
      "terminals": [
        {
          "id": "test",
          "name": "Catalog tests",
          "command": "node --test --test-reporter=spec search.test.js",
          "kind": "task",
          "action": "validation"
        }
      ],
      "position": { "x": 720, "y": 120 }
    },
    {
      "id": "docs",
      "name": "Documentation",
      "kind": "other",
      "path": "docs",
      "notes": "Product and developer documentation.",
      "terminals": [],
      "position": { "x": 360, "y": 260 }
    }
  ],
  "links": [
    { "id": "web-api", "source": "web", "target": "api", "label": "calls" },
    { "id": "web-catalog", "source": "web", "target": "catalog", "label": "shared types" },
    { "id": "api-catalog", "source": "api", "target": "catalog", "label": "imports" }
  ],
  "groups": [
    {
      "id": "local-stack",
      "name": "Local stack",
      "componentIds": ["catalog", "api", "web"],
      "orderedStartup": true,
      "readinessTimeoutSeconds": 60
    }
  ]
}
JSON
git add .
git commit -qm 'Northstar storefront, API and catalog'

# The task's uncommitted work.
work="$dir/northstar-add-product-search"
git worktree add -q -b add-product-search "$work"
cat > "$work/packages/catalog/search.js" <<'JS'
const products = require('./products.js')

/** Products whose name contains `query`, ignoring case and surrounding whitespace. */
function search(query) {
  const needle = query.trim().toLowerCase()
  if (!needle) return products
  return products.filter((p) => p.name.toLowerCase().includes(needle))
}

module.exports = { search }
JS
cat > "$work/packages/catalog/search.test.js" <<'JS'
const test = require('node:test')
const assert = require('node:assert')
const { search } = require('./search.js')

test('matches product names', () => {
  assert.deepStrictEqual(search('Ridge').map((p) => p.id), [3])
})
test('returns all products for an empty query', () => {
  assert.strictEqual(search('').length, 3)
})
test('returns no products for an unknown query', () => {
  assert.deepStrictEqual(search('kayak'), [])
})
test('matches product names without case sensitivity', () => {
  assert.deepStrictEqual(search('trail').map((p) => p.id), [1])
})
test('ignores surrounding whitespace', () => {
  assert.deepStrictEqual(search('  summit ').map((p) => p.id), [2])
})
JS
cat > "$work/apps/web/index.html" <<'HTML'
<!doctype html>
<title>Northstar</title>
<h1>Northstar outfitters</h1>
<input id="search" type="search" placeholder="Search products" autofocus />
<ul id="products"></ul>
<script type="module" src="./main.js"></script>
HTML

# A stand-in planner, named so Patchbay briefs it as Claude: prints a planning conversation, saves
# the plan, and waits at a prompt.
cat > "$dir/claude" <<'SH'
#!/bin/sh
printf '\033[1m> Plan product search for the storefront\033[0m\n\n'
sleep 0.3
printf '  Reading Web app, Catalog and their links…\n'
printf '  ✓ apps/web/index.html      storefront markup\n'
printf '  ✓ packages/catalog/search.js  substring match, case-sensitive\n\n'
sleep 0.3
cat > "$PATCHBAY_PLAN_FILE" <<'PLAN'
# Add product search

## Goal
Let shoppers search the catalog from the storefront.

## Steps
1. **Catalog** — make `search` ignore case and surrounding whitespace; an empty query returns
   every product.
2. **Catalog** — cover empty, unknown, mixed-case and padded queries in `search.test.js`.
3. **Web app** — add a search field above the product list.

## Checks
- Catalog tests pass.
- The storefront renders the search field.
PLAN
printf '  Plan saved for implementation:\n\n'
printf '    1. Catalog: case- and whitespace-insensitive search\n'
printf '    2. Catalog: tests for empty, unknown, mixed-case queries\n'
printf '    3. Web app: search field above the product list\n\n'
printf '\033[2m  Agreed? Implement → hands this plan to a fresh agent.\033[0m\n\n> '
exec cat >/dev/null
SH
chmod +x "$dir/claude"
