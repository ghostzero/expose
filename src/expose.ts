import { io } from 'socket.io-client'
import net from 'net'

const PORT_TO_EXPOSE = parseInt(process.argv[2]) || 4455
const socket = io('http://localhost:3000')

const tcpClients: {
    [id: string]: net.Socket
} = {}

socket.on('connect', () => {
    console.log('Connected to server, requesting to expose port:', PORT_TO_EXPOSE)
    socket.emit('expose', PORT_TO_EXPOSE)
})

socket.on('exposed', (localPort, exposedUrl) => {
    console.log(`Server is exposing ${localPort} at ${exposedUrl}`)
})

socket.on('tcp:connection', (receivedId) => {
    console.log(`Establishing TCP client for id: ${receivedId}`)

    // Create a TCP client to connect to localhost:4455
    tcpClients[receivedId] = net.createConnection({port: 4455, host: 'localhost'}, () => {
        console.log(`TCP client connected to localhost:${PORT_TO_EXPOSE}`)
    })

    tcpClients[receivedId].on('data', (data) => {
        socket.emit('tcp:data', receivedId, data)
    })

    tcpClients[receivedId].on('end', () => {
        console.log(`TCP client disconnected from localhost:${PORT_TO_EXPOSE}`)
    })

    tcpClients[receivedId].on('error', (err) => {
        console.error(`Error in TCP client for id ${receivedId}: ${err.message}`)
        tcpClients[receivedId].end()
    })
})

socket.on(`tcp:data`, (receivedId, data) => {
    if (tcpClients[receivedId]) {
        tcpClients[receivedId].write(data)
    }
})

socket.on(`tcp:close`, (receivedId) => {
    if (tcpClients[receivedId]) {
        console.log(`Closing TCP client for id: ${receivedId}`)
        tcpClients[receivedId].end()
    }
})

socket.on('disconnect', () => {
    console.log('Disconnected from server')
})

socket.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`)
})