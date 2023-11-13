import { io } from 'socket.io-client'
import net from 'net'
import jwt from 'jsonwebtoken'
import axios from 'axios'

const PORT_TO_EXPOSE = parseInt(process.argv[2]) || 4455
const CUSTOM_SECRET = process.argv[3]

const token = jwt.sign({
    sub: 1,
}, 'your_secret_key')

const socket = io('http://localhost:3000', {
    query: {token, version: 1},
})

const tcpClients: {
    [id: string]: net.Socket
} = {}

socket.on('connect', () => {
    console.log('Connected to server, requesting to expose port:', PORT_TO_EXPOSE)
    socket.emit('expose', {port: PORT_TO_EXPOSE, secret: CUSTOM_SECRET})
})

socket.on('exposed', ({port, url, secret}) => {
    console.log(`Server is exposing ${port} at ${url} using secret ${secret}`)

    const remotePort = url.split(':')[2]

    // allow list host
    axios.post('http://localhost:3000/allow-list', jwt.sign({
        url,
        ip: '::ffff:127.0.0.1',
        port: remotePort,
    }, secret), {
        headers: {
            'Content-Type': 'text/plain',
        },
    }).then(res => {
        console.log('allow list result:', res.data)
    }).catch(err => {
        console.log('allow list error:', err.response.data)
    })
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