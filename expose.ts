import { io } from 'socket.io-client'
import net from 'net'
import jwt, { JwtPayload } from 'jsonwebtoken'
import axios from 'axios'
import 'dotenv/config'

const PORT_TO_EXPOSE = parseInt(process.argv[2]) || 4455
const CUSTOM_SECRET = process.argv[3]
const CUSTOM_ALIAS = process.argv[4]
const BASE_URL = process.env.BASE_URL || 'https://irl-fkb1-2.ghostzero.de:3000'

const token: string = jwt.sign({
    sub: '1',
} as JwtPayload, 'your_secret_key')

const socket = io(BASE_URL, {
    query: {token, version: 1},
})

const tcpClients: {
    [id: string]: net.Socket
} = {}

socket.on('connect', () => {
    console.log('Connected to server, requesting to expose port:', PORT_TO_EXPOSE)
    socket.emit('expose', {port: PORT_TO_EXPOSE, secret: CUSTOM_SECRET, alias: CUSTOM_ALIAS})
})

socket.on('exposed', async ({port, url, secret, alias}) => {
    console.log(`Port ${port} exposed at ${url} with secret ${secret} and alias ${alias}`)

    const remotePort = url.split(':')[2]

    // allow list host machine IPs
    const localIps = ['::ffff:127.0.0.1', '::1', '127.0.0.1', '::ffff:109.91.131.189']
    localIps.forEach(ip => axios.post(`${BASE_URL}/allow-list`, jwt.sign({
        ip,
        port: remotePort,
    }, secret), {
        headers: {
            'Content-Type': 'text/plain',
        },
    }).then(res => {
        console.log(`allow list result ${remotePort}:`, res.data)
    }).catch(err => {
        console.log(`allow list error ${remotePort}:`, err.response.data)
    }))
})

socket.on('tcp:connection', ({id}) => {
    console.log(`Establishing TCP client for id: ${id}`)

    const tcpClient = net.createConnection({port: PORT_TO_EXPOSE, host: 'localhost'}, () => {
        console.log(`TCP client connected to localhost:${PORT_TO_EXPOSE}`)
    })

    tcpClients[id] = tcpClient

    tcpClient.on('data', (data) => {
        socket.emit('tcp:data', {id, data})
    })

    tcpClient.on('end', () => {
        console.log(`TCP client disconnected from localhost:${PORT_TO_EXPOSE}`)
    })

    tcpClient.on('error', (err) => {
        console.error(`Error in TCP client for id ${id}: ${err.message}`)
        tcpClient.end()
    })
})

socket.on(`tcp:data`, ({id, data}) => {
    tcpClients[id]?.write(data)
})

socket.on(`tcp:close`, ({id}) => {
    console.log(`Closing TCP client for id: ${id}`)
    tcpClients[id]?.end()
})

socket.on('disconnect', () => {
    console.log('Disconnected from server')
    // Cleanup resources on client side
    Object.values(tcpClients).forEach(client => client.end())
})

socket.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`)
})