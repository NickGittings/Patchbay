import { createServer } from 'node:http'
createServer((_, response) => {
  response.setHeader('Content-Type', 'text/plain')
  response.end('Patchbay preview fixture\n')
}).listen(3037, '127.0.0.1', () => process.stdout.write('Preview: http://127.0.0.1:3037\n'))
