import express, { Express, NextFunction, Request, Response } from 'express'
import { createServer as createHttpServer, Server as HttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { Server, Socket } from 'socket.io'
import net from 'net'
import jwt from 'jsonwebtoken'
import * as crypto from 'crypto'
import 'dotenv/config'
// @ts-ignore
import petname from 'node-petname'
import * as fs from 'node:fs'

const privateKeyPath = process.env.SSL_KEY_PATH
const certificatePath = process.env.SSL_CERT_PATH

const createServer = (app: Express): HttpServer => {
    return privateKeyPath && certificatePath
        ? createHttpsServer({
            key: fs.readFileSync(privateKeyPath),
            cert: fs.readFileSync(certificatePath),
        }, app)
        : createHttpServer(app)
}

const app: Express = express()
const http: HttpServer = createServer(app)
const io: Server = new Server(http)

const minPort: number = 4456
const maxPort: number = minPort + 1000
const allocatedPorts: Set<number> = new Set()
const allocatedAliases: Set<string> = new Set()

const allowLists: {
    [port: number]: {
        alias: string
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

    jwt.verify(token, 'your_secret_key', (err: unknown, user: unknown) => {
        if (err) return res.sendStatus(403)
        // @ts-ignore
        req.user = user
        next()
    })
}

app.use(express.text(), express.json())

app.get('/', (_req: Request, res: Response) => {
    res.send('<h1>Hello world</h1>')
})

app.get('/l/:alias', (req: Request, res: Response) => {
    // find the alias and their corresponding port
    const aliases = Object.entries(allowLists).map(([port, {alias}]) => ({port, alias}))
    const alias = aliases.find(({alias}) => alias === req.params.alias)

    if (!alias) return res.status(404).send('Alias not found')

    res.json(alias)
})

app.get('/ports', authenticateToken, (_req: Request, res: Response) => {
    res.json(Array.from(allocatedPorts))
})

app.post('/allow-list', (req: Request, res: Response) => {
    if (!req.body) return res.status(400).send('Token is required')

    const unverified: any = jwt.decode(req.body as string)

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


io.use((socket: Socket, next: any) => {
    const token = socket.handshake.query.token as string
    jwt.verify(token, 'your_secret_key', (err, decoded) => {
        if (err) return next(new Error('Authentication error'))
        // @ts-ignored
        socket.decoded = decoded
        next()
    })
})

io.on('connection', (ws) => {
    console.log('a user connected')

    // Store references to user-specific resources for cleanup
    const userResources: {
        tcpServers: Set<{
            requestedPort: number,
            tcpServer: net.Server,
        }>,
        clientSockets: Set<string>,
    } = {
        tcpServers: new Set(),
        clientSockets: new Set(),
    }

    ws.on('expose', async ({port, secret, alias}: { port: number, secret?: string, alias?: string }) => {
        console.log(`Client requested to expose their localhost:${port}`)
        const requestedPort: number = await findNextAvailablePort()
        const requestedAlias: string = findNextAvailableAlias(alias)
        allocatedPorts.add(requestedPort)
        allocatedAliases.add(requestedAlias)

        allowLists[requestedPort] = {
            alias: requestedAlias,
            secret: secret || crypto.randomBytes(32).toString('base64'),
            ips: new Set(),
        }

        const tcpServer: net.Server = net.createServer()
        tcpServers.push(tcpServer)
        userResources.tcpServers.add({requestedPort, tcpServer})

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

            const id = Math.random().toString(36).slice(2, 9)
            clients[id] = clientSocket
            userResources.clientSockets.add(id)

            console.log(`client ${id} (${clientIP}) connected to tcp server`)

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

        ws.on('tcp:data', ({id, data, type}) => {
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
            alias: requestedAlias,
            url: `${process.env.APP_URL}:${requestedPort}`,
            secret: allowLists[requestedPort].secret,
        })
    })

    ws.on('disconnect', () => {
        console.log('user disconnected')
        // Close and remove all TCP servers allocated to the user
        userResources.tcpServers.forEach(server => {
            server.tcpServer.close(() => {
                console.log(`Closed TCP server on port ${server.requestedPort}`)
                allocatedPorts.delete(server.requestedPort)
                allocatedAliases.delete(allowLists[server.requestedPort].alias)
                delete allowLists[server.requestedPort]
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

    ws.on('error', (err: Error) => {
        console.error(`WebSocket error: ${err.message}`)
    })
})

http.listen(3000, () => {
    console.log(`server running on port 3000 and exposes via ${process.env.APP_URL}`)
})

const findNextAvailablePort = async () => {
    for (let port = minPort; port <= maxPort; port++) {
        if (!allocatedPorts.has(port) && await isPortAvailable(port)) {
            return port
        }
    }
    throw new Error('No available ports')
}

const findNextAvailableAlias = (requestedAlias: string | undefined): string => {
    if (requestedAlias && !allocatedAliases.has(requestedAlias)) {
        return requestedAlias
    }

    for (let i = 0; i < 100; i++) {
        const random4Letters = Math.random().toString(36).slice(2, 6)
        const randomAnimalName = petname(2, '-')
        const fallbackAlias = `exposed-${randomAnimalName}-${random4Letters}`

        if (!allocatedAliases.has(fallbackAlias)) {
            return fallbackAlias
        }
    }

    throw new Error('No available aliases')
}

const isPortAvailable = (port: number) => {
    return new Promise(resolve => {
        const testServer = net.createServer()
            .once('error', (err: Error & { code: string }) => {
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