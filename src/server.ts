import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import net from 'net'

const app = express()
const http = createServer(app)
const io = new Server(http)

let minPort = 10000
const maxPort = 20000
const allocatedPorts = new Set()

const clients: {
    [id: string]: net.Socket
} = {}

const tcpServers: net.Server[] = []

app.get('/', (req, res) => {
    res.send('<h1>Hello world</h1>')
})

app.get('/ports', (req, res) => {
    res.json(Array.from(allocatedPorts))
})

io.on('connection', (ws) => {
    console.log('a user connected')

    // Store references to user-specific resources for cleanup
    const userResources = {
        tcpServers: new Set<net.Server>(),
        clientSockets: new Set<string>(),
    }

    ws.on('expose', async (port) => {
        console.log(`Client requested to expose their localhost:${port}`)
        let requestedPort = await findNextAvailablePort()
        allocatedPorts.add(requestedPort)

        const tcpServer = net.createServer()
        tcpServers.push(tcpServer)
        userResources.tcpServers.add(tcpServer)

        tcpServer.on('connection', (sc) => {
            const id = Math.random().toString(36).substr(2, 9)
            clients[id] = sc
            userResources.clientSockets.add(id)

            console.log(`client ${id} connected to tcp server`)

            sc.on('data', (data) => {
                ws.emit('tcp:data', id, data)
            })

            sc.on('close', () => {
                console.log('client disconnected from tcp server')
                ws.emit('tcp:close', id)
                delete clients[id]
                userResources.clientSockets.delete(id)
            })

            sc.on('error', (err) => {
                console.error(`Error in TCP client ${id}: ${err.message}`)
            })

            ws.emit('tcp:connection', id)
        })

        ws.on('tcp:data', (id, data) => {
            clients[id]?.write(data)
        })

        ws.on('tcp:close', (id) => {
            clients[id]?.end()
        })

        tcpServer.listen(requestedPort, () => {
            console.log(`Server listening on port ${requestedPort} which will be forwarded to client`)
        })

        ws.emit('exposed', port, `tcp://localhost:${requestedPort}`)
    })

    ws.on('disconnect', () => {
        console.log('user disconnected')
        // Cleanup resources for this WebSocket client
        userResources.tcpServers.forEach(server => {
            const address = server.address()
            if (address && typeof address === 'object') {
                console.log(`Closing TCP server on port ${address.port}`)
                allocatedPorts.delete(address.port)
            }
            server.close()
        })
        userResources.clientSockets.forEach(id => {
            if (clients[id]) {
                clients[id].destroy()
                delete clients[id]
            }
        })
    })

    ws.on('error', (err) => {
        console.error(`WebSocket error: ${err.message}`)
    })
})

http.listen(3000, () => {
    console.log('server running at http://localhost:3000')
})

async function findNextAvailablePort() {
    for (let port = minPort; port <= maxPort; port++) {
        if (!allocatedPorts.has(port) && await isPortAvailable(port)) {
            return port
        }
    }
    throw new Error('No available ports')
}

function isPortAvailable(port: number) {
    return new Promise(resolve => {
        const testServer = net.createServer()
            .once('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(false)
                } else {
                    resolve(true)
                }
            })
            .once('listening', () => {
                testServer.close()
                resolve(true)
            })
            .listen(port)
    })
}