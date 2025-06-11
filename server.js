// server.js - Enhanced Node.js WebRTC Signaling Server for Multi-User

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // For generating unique peer IDs

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to store rooms. Each room maps a room ID to a Map of WebSocket clients (peerId -> WebSocket).
// This allows tracking multiple peers in a room and addressing them by their unique peer IDs.
const rooms = new Map(); // Map<roomId, Map<peerId, WebSocket>>

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for root path, serves the index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

wss.on('connection', ws => {
    // Assign a unique peer ID to each new WebSocket connection
    const peerId = uuidv4();
    ws.peerId = peerId; // Attach peerId directly to the WebSocket object for easy access
    ws.currentRoomId = null; // To track which room this peer is currently in

    console.log(`Client connected: ${peerId}`);

    // Send the assigned peer ID to the client
    ws.send(JSON.stringify({ type: 'your-peer-id', peerId: peerId }));

    ws.on('message', message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Failed to parse message from client:', message, e);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
            return;
        }

        console.log(`Received message: ${data.type} from ${peerId} in room ${data.roomId || 'N/A'}`);

        switch (data.type) {
            case 'join-room':
                const roomIdToJoin = data.roomId;
                if (!roomIdToJoin) {
                    console.warn(`join-room message received from ${peerId} without a roomId.`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Room ID is required.' }));
                    return;
                }

                if (ws.currentRoomId && ws.currentRoomId !== roomIdToJoin) {
                    // If peer is already in a different room, leave that room first
                    leaveRoom(ws);
                }

                ws.currentRoomId = roomIdToJoin;

                if (!rooms.has(roomIdToJoin)) {
                    rooms.set(roomIdToJoin, new Map()); // Initialize room with a new Map of clients
                }

                const roomClients = rooms.get(roomIdToJoin);

                // Send a list of existing peers to the newly joining peer
                if (roomClients.size > 0) {
                    const existingPeerIds = Array.from(roomClients.keys());
                    ws.send(JSON.stringify({
                        type: 'existing-peers',
                        roomId: roomIdToJoin,
                        peers: existingPeerIds
                    }));
                    console.log(`Sent existing peers to new client ${peerId} in room ${roomIdToJoin}:`, existingPeerIds);
                }

                roomClients.set(peerId, ws); // Add the new peer to the room
                console.log(`Client ${peerId} joined room: ${roomIdToJoin}. Current clients in room: ${roomClients.size}`);

                // Notify all *other* existing peers in the room about the new peer joining
                for (const [existingPeerId, client] of roomClients) {
                    if (existingPeerId !== peerId && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'new-peer-joined',
                            roomId: roomIdToJoin,
                            newPeerId: peerId
                        }));
                        console.log(`Notified ${existingPeerId} that ${peerId} joined room ${roomIdToJoin}`);
                    }
                }

                ws.send(JSON.stringify({ type: 'joined-room', roomId: roomIdToJoin, peerId: peerId }));
                break;

            case 'offer':
            case 'answer':
            case 'ice-candidate':
                // These messages must specify a target peer ID to route correctly
                const targetPeerId = data.targetPeerId;
                if (!targetPeerId) {
                    console.warn(`Signaling message (${data.type}) from ${peerId} missing targetPeerId.`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Signaling message requires a targetPeerId.' }));
                    return;
                }

                if (ws.currentRoomId && rooms.has(ws.currentRoomId)) {
                    const clientsInRoom = rooms.get(ws.currentRoomId);
                    const targetClient = clientsInRoom.get(targetPeerId);

                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        // Forward the signaling message (offer, answer, or ICE candidate)
                        // Add senderPeerId to the message so the receiver knows who it's from
                        targetClient.send(JSON.stringify({
                            ...data,
                            senderPeerId: peerId // Crucial for multi-peer connections
                        }));
                        console.log(`Relayed ${data.type} from ${peerId} to ${targetPeerId} in room ${ws.currentRoomId}`);
                    } else {
                        console.warn(`Target peer ${targetPeerId} not found or not open in room ${ws.currentRoomId} for message type ${data.type}.`);
                        ws.send(JSON.stringify({ type: 'error', message: `Target peer ${targetPeerId} not found or not available.` }));
                    }
                } else {
                    console.warn(`Signaling message (${data.type}) received from ${peerId} not in a room or invalid room ID.`);
                    ws.send(JSON.stringify({ type: 'error', message: 'You are not in a valid room to send signaling data.' }));
                }
                break;

            default:
                console.warn(`Unknown message type: ${data.type} from ${peerId}`);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${data.type}` }));
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${peerId}`);
        leaveRoom(ws); // Ensure peer is removed from room on disconnect
    });

    ws.on('error', error => {
        console.error(`WebSocket error for ${peerId}:`, error);
        leaveRoom(ws); // Also handle errors by leaving the room
    });
});

/**
 * Removes a WebSocket client from its current room and notifies other peers.
 * @param {WebSocket} ws - The WebSocket client to remove.
 */
function leaveRoom(ws) {
    if (ws.currentRoomId && rooms.has(ws.currentRoomId)) {
        const roomClients = rooms.get(ws.currentRoomId);
        roomClients.delete(ws.peerId);
        console.log(`Client ${ws.peerId} left room: ${ws.currentRoomId}. Remaining clients: ${roomClients.size}`);

        if (roomClients.size === 0) {
            rooms.delete(ws.currentRoomId);
            console.log(`Room ${ws.currentRoomId} is now empty and removed.`);
        } else {
            // Notify remaining peers that this peer has disconnected
            for (const [remainingPeerId, client] of roomClients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'peer-left',
                        roomId: ws.currentRoomId,
                        leavingPeerId: ws.peerId,
                        message: `Peer ${ws.peerId} has disconnected.`
                    }));
                    console.log(`Notified ${remainingPeerId} that ${ws.peerId} left room ${ws.currentRoomId}`);
                }
            }
        }
        ws.currentRoomId = null; // Clear the room ID for the disconnected client
    }
}


const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Enhanced signaling server listening on http://localhost:${PORT}`);
    console.log(`Make sure your frontend (index.html) is in a 'public' directory.`);
});
