import express, { NextFunction, Request, Response } from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import net from 'net'
import jwt from 'jsonwebtoken'
import * as crypto from 'crypto'

const app = express()
const http = createServer(app)
const io = new Server(http)

let minPort = 4456
const maxPort = minPort + 1000
const allocatedPorts = new Set()

const allowLists: {
    [port: number]: {
        secret: string
        ips: Set<string>
    }
} = {}

const clients: {
    [id: string]: net.Socket
} = {}

const tcpServers: net.Server[] = []

const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]

    if (token == null) return res.sendStatus(401)

    jwt.verify(token, 'your_secret_key', (err, user) => {
        if (err) return res.sendStatus(403)
        // @ts-ignore
        req.user = user
        next()
    })
}

app.use(express.text(), express.json())

app.get('/', (req, res) => {
    res.send('<h1>Hello world</h1>')
})

app.get('/ports', authenticateToken, (req, res) => {
    res.json(Array.from(allocatedPorts))
})

app.post('/allow-list', (req, res) => {
    if (!req.body) return res.status(400).send('Token is required')

    const unverified = jwt.decode(req.body as string) as {
        port?: number
    } || undefined

    if (!unverified) return res.status(400).send('Invalid token')
    if (!unverified.port) return res.status(400).send('Port is required')

    const record = allowLists[unverified.port] || undefined
    if (!record) return res.status(400).send('Port no longer exists')

    jwt.verify(req.body as string, record.secret, (err, decoded) => {
        if (err) return res.sendStatus(403)
        if (typeof decoded !== 'object') return res.status(400).send('Invalid token')
        if (!decoded) return res.status(400).send('Invalid token')
        if (!decoded.ip) return res.status(400).send('IP is required')
        if (!decoded.port) return res.status(400).send('Port is required')

        record.ips.add(decoded.ip)
        res.send(`IP ${decoded.ip} added to allow list for port ${decoded.port}`)
    })
})


io.use((socket, next) => {
    const token = socket.handshake.query.token as string
    jwt.verify(token, 'your_secret_key', (err, decoded) => {
        if (err) return next(new Error('Authentication error'))
        // @ts-ignore
        socket.decoded = decoded
        next()
    })
})

io.on('connection', (ws) => {
    console.log('a user connected')

    // Store references to user-specific resources for cleanup
    const userResources = {
        tcpServers: new Set<net.Server>(),
        clientSockets: new Set<string>(),
    }

    ws.on('expose', async ({port, secret}) => {
        console.log(`Client requested to expose their localhost:${port}`)
        let requestedPort = await findNextAvailablePort()
        allocatedPorts.add(requestedPort)

        allowLists[requestedPort] = {
            secret: secret || crypto.randomBytes(32).toString('base64'),
            ips: new Set(),
        }

        const tcpServer = net.createServer()
        tcpServers.push(tcpServer)
        userResources.tcpServers.add(tcpServer)

        tcpServer.on('connection', (clientSocket) => {
            const clientIP = clientSocket.remoteAddress as string

            if (!clientIP) {
                console.error('Could not get client IP')
                return
            }

            if (!allowLists[requestedPort] || !allowLists[requestedPort].ips.has(clientIP)) {
                console.log(`Client IP ${clientIP} not in allow list for port ${requestedPort}`)
                clientSocket.end() // End the connection if the IP is not in the allow list
                return
            }

            const id = Math.random().toString(36).substr(2, 9)
            clients[id] = clientSocket
            userResources.clientSockets.add(id)

            console.log(`client ${id} connected to tcp server`)

            clientSocket.on('data', (data) => {
                ws.emit('tcp:data', {id, data})
            })

            clientSocket.on('close', () => {
                console.log('client disconnected from tcp server')
                ws.emit('tcp:close', id)
                delete clients[id]
                userResources.clientSockets.delete(id)
            })

            clientSocket.on('error', (err) => {
                console.error(`Error in TCP client ${id}: ${err.message}`)
            })

            ws.emit('tcp:connection', {id})
        })

        ws.on('tcp:data', ({id, data}) => {
            clients[id]?.write(data)
        })

        ws.on('tcp:close', ({id}) => {
            clients[id]?.end()
        })

        tcpServer.listen(requestedPort, () => {
            console.log(`Server listening on port ${requestedPort} which will be forwarded to client`)
        })

        ws.emit('exposed', {
            port,
            url: `tcp://localhost:${requestedPort}`,
            secret: allowLists[requestedPort].secret,
        })
    })

    ws.on('disconnect', () => {
        console.log('user disconnected')
        // Close and remove all TCP servers allocated to the user
        userResources.tcpServers.forEach(server => {
            server.close(() => {
                const address = server.address()
                if (address && typeof address === 'object') {
                    console.log(`Closed TCP server on port ${address.port}`)
                    allocatedPorts.delete(address.port)
                    delete allowLists[address.port]
                }
            })
        })

        // Destroy and remove all client sockets
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