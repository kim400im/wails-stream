import { useState, useEffect } from 'react';
import './App.css';
import { JoinRoom, SendMessage, StartStreaming, SendFrameData } from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime';

interface ClientInfo {
    public_ip: string;
    private_ip: string;
    port: string;
}

interface MessageData {
    sender: string;
    message: string;
}

function App() {
    const [roomName, setRoomName] = useState('');
    const [message, setMessage] = useState('');
    const [chatLog, setChatLog] = useState<string[]>([]);
    const [peerList, setPeerList] = useState<ClientInfo[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);

    useEffect(() => {
        const cleanupMsgListener = EventsOn('new-message-received', (data: MessageData) => {
            if (data.message.includes('펀칭!')) return;
            setChatLog(prevLog => [...prevLog, `[${data.sender}]: ${data.message}`]);
        });

        const cleanupPeerListener = EventsOn('peer-list-updated', (peers: ClientInfo[]) => {
            setPeerList(peers || []);
        });

        const cleanupVideoListener = EventsOn('video-receiving-started', () => {
            setChatLog(prevLog => [...prevLog, "System: Receiving video stream..."]);
        });

        const cleanupFrameListener = EventsOn('frame-received', (frameData: number[]) => {
            const blob = new Blob([new Uint8Array(frameData)], { type: 'image/png' });
            const url = URL.createObjectURL(blob);
            
            const imgElement = document.getElementById('received-frame');
            if (imgElement) {
                (imgElement as HTMLImageElement).src = url;
            }
        });

        return () => {
            cleanupMsgListener();
            cleanupPeerListener();
            cleanupVideoListener();
            cleanupFrameListener();
        };
    }, []);

    const handleJoinRoom = () => {
        if (roomName) {
            JoinRoom(roomName).then(result => {
                setChatLog(prevLog => [...prevLog, `System: ${result}`]);
            });
        }
    };

    const handleSendMessage = () => {
        if (message) {
            SendMessage(message);
            setChatLog(prevLog => [...prevLog, `You: ${message}`]);
            setMessage('');
        }
    };

    const handleStartStreaming = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });

            setIsStreaming(true);
            setChatLog(prevLog => [...prevLog, "System: Webcam streaming started..."]);

            // ✅ 비디오 요소 생성 및 화면에 표시
            const videoElement = document.createElement('video');
            videoElement.srcObject = stream;
            videoElement.autoplay = true;
            videoElement.id = 'streaming-video';
            videoElement.style.width = '640px';
            videoElement.style.height = '480px';
            videoElement.style.border = '1px solid black';
            videoElement.style.marginTop = '10px';

            // 기존 비디오 제거 후 새로 추가
            const existingVideo = document.getElementById('streaming-video');
            if (existingVideo) existingVideo.remove();
            document.body.appendChild(videoElement);

            // 프레임 캡처 및 Go 백엔드로 전송
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            canvas.width = 1280;
            canvas.height = 720;

            const captureFrame = async () => {
                if (!isStreaming) return;

                ctx?.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
                
                // ✅ Blob을 ArrayBuffer로 변환
                canvas.toBlob(async (blob) => {
                    if (blob) {
                        const arrayBuffer = await blob.arrayBuffer();
                        const byteArray = new Uint8Array(arrayBuffer);
                        
                        // Go 백엔드로 바이트 배열 전송
                        SendFrameData(Array.from(byteArray));
                    }
                    setTimeout(captureFrame, 33); // 30fps
                });
            };

            captureFrame();

            // Go 백엔드의 StartStreaming 호출
            // StartStreaming();

        } catch (err) {
            console.error("Webcam access failed:", err);
            setChatLog(prevLog => [...prevLog, `System: Webcam access failed - ${err}`]);
        }
    };

    const handleStopStreaming = () => {
        setIsStreaming(false);
        setChatLog(prevLog => [...prevLog, "System: Streaming stopped"]);
        
        // ✅ 비디오 요소 제거
        const videoElement = document.getElementById('streaming-video');
        if (videoElement) {
            videoElement.remove();
        }
    };

    return (
        <div className="container">
            <h1>P2P Streamer</h1>
            <div className="input-box">
                <input
                    placeholder="Enter Room Name"
                    type="text"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleJoinRoom()}
                />
                <button onClick={handleJoinRoom}>Join Room</button>
                <button 
                    onClick={isStreaming ? handleStopStreaming : handleStartStreaming}
                    style={{backgroundColor: isStreaming ? '#dc3545' : '#28a745'}}
                >
                    {isStreaming ? 'Stop Streaming' : 'Start Streaming'}
                </button>
            </div>

            <div className="main-content">
                <div className="peer-list">
                    <h3>Connected Peers ({peerList.length})</h3>
                    <ul>
                        {peerList.map((peer, index) => (
                            <li key={index}>{`${peer.public_ip}:${peer.port}`}</li>
                        ))}
                    </ul>
                </div>
                <div className="video-received">
                    <h3>Received Stream</h3>
                    <img id="received-frame" style={{width: '640px', height: '480px', border: '1px solid black'}} />
                </div>
                <div className="chat-area">
                    <div id="chat-box">
                        {chatLog.map((msg, index) => (
                            <p key={index}>{msg}</p>
                        ))}
                    </div>
                    <div className="input-box">
                        <input
                            placeholder="Enter message"
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                        />
                        <button onClick={handleSendMessage}>Send</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;