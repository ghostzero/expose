import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import net from 'net'

const app = express()
const server = createServer(app)
const io = new Server(server)

let nextPort = 10000

const clients: {
    [id: string]: net.Socket
} = {}

app.get('/', (req, res) => {
    res.send('<h1>Hello world</h1>')
})

io.on('connection', (ws) => {
    console.log('a user connected')

    ws.on('expose', async (port) => {
        console.log(`Client requested to expose their localhost:${port}`)
        let requestedPort = nextPort++

        // Check for port availability
        while (!await isPortAvailable(requestedPort)) {
            requestedPort = nextPort++
        }

        // create a new tcp server which listens on a random port
        const tcpServer = net.createServer()

        tcpServer.on('connection', (sc) => {
            const id = Math.random().toString(36).substr(2, 9)
            clients[id] = sc

            console.log(`client ${id} connected to tcp server`)

            sc.on('data', (data) => {
                ws.emit('tcp:data', id, data)
            })

            sc.on('close', () => {
                console.log('client disconnected from tcp server')
                ws.emit('tcp:close', id)
                delete clients[id]
            })

            sc.on('error', (err) => {
                console.error(`Error in TCP client ${id}: ${err.message}`)
            })

            ws.emit('tcp:connection', id)
        })

        ws.on('tcp:data', (id, data) => {
            if (clients[id]) {
                clients[id].write(data)
            }
        })

        ws.on('tcp:close', (id) => {
            if (clients[id]) {
                clients[id].end()
            }
        })

        tcpServer.listen(requestedPort, () => {
            console.log(`Server listening on port ${requestedPort} which will be forwarded to client`)
        })

        ws.emit('exposed', port, `tcp://localhost:${requestedPort}`)
    })

    ws.on('disconnect', () => {
        console.log('user disconnected')
        // todo: Clean up any resources or connections related to this WebSocket client
    })

    ws.on('error', (err) => {
        console.error(`WebSocket error: ${err.message}`)
    })
})

server.listen(3000, () => {
    console.log('server running at http://localhost:3000')
})

/**
 * Checks if a port is available to use.
 * @param {number} port - Port number to check.
 * @returns {Promise<boolean>} - Promise resolving to true if the port is available, false otherwise.
 */
function isPortAvailable(port: number) {
    return new Promise(resolve => {
        const testServer = net.createServer()
            .once('error', err => {
                // @ts-ignore
                if (err.code === 'EADDRINUSE') {
                    resolve(false) // Port is in use
                } else {
                    resolve(true) // Port is available but another error occurred
                }
            })
            .once('listening', () => {
                testServer.close()
                resolve(true) // Port is available
            })
            .listen(port)
    })
}