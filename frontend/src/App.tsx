import { useState, useEffect, useRef } from 'react';
import './App.css';
import { JoinRoom, SendMessage, SendFrameData } from '../wailsjs/go/main/App';
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
    
    // Ref로 상태 관리
    const streamingRef = useRef(false);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number>(0);

    useEffect(() => {
        const cleanupMsgListener = EventsOn('new-message-received', (data: MessageData) => {
            if (data.message.includes('펀칭!')) return;
            setChatLog(prevLog => [...prevLog, `[${data.sender}]: ${data.message}`]);
        });

        const cleanupPeerListener = EventsOn('peer-list-updated', (peers: ClientInfo[]) => {
            console.log('📡 피어 목록 업데이트:', peers);
            setPeerList(peers || []);
        });

        const cleanupFrameListener = EventsOn('frame-received', (frameData: number[]) => {
            console.log(`📥 프레임 수신: ${frameData.length} bytes`);
            
            const blob = new Blob([new Uint8Array(frameData)], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            
            const imgElement = document.getElementById('received-frame') as HTMLImageElement;
            if (imgElement) {
                imgElement.onload = () => {
                    console.log('✅ 이미지 렌더링 성공');
                    URL.revokeObjectURL(url);
                };
                imgElement.onerror = () => {
                    console.error('❌ 이미지 렌더링 실패');
                    URL.revokeObjectURL(url);
                };
                imgElement.src = url;
            }
        });

        return () => {
            cleanupMsgListener();
            cleanupPeerListener();
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
            console.log('🎥 웹캠 접근 시도...');
            
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                },
                audio: false
            });

            console.log('✅ 웹캠 접근 성공');
            
            mediaStreamRef.current = stream;
            setIsStreaming(true);
            streamingRef.current = true;
            setChatLog(prevLog => [...prevLog, "System: Webcam streaming started..."]);

            // 비디오 요소 생성
            let videoElement = document.getElementById('streaming-video') as HTMLVideoElement;
            if (!videoElement) {
                videoElement = document.createElement('video');
                videoElement.id = 'streaming-video';
                videoElement.style.width = '640px';
                videoElement.style.height = '480px';
                videoElement.style.border = '2px solid green';
                videoElement.style.marginTop = '10px';
                document.body.appendChild(videoElement);
            }
            
            videoElement.srcObject = stream;
            videoElement.autoplay = true;
            videoElement.muted = true;
            videoElement.playsInline = true;

            // 캔버스 생성
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            canvas.width = 640;
            canvas.height = 480;

            let frameCount = 0;

            const captureFrame = () => {
                if (!streamingRef.current) {
                    console.log('⏹️ 스트리밍 중지됨');
                    return;
                }

                // 비디오가 준비되었는지 확인
                if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
                    if (ctx) {
                        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
                        
                        canvas.toBlob(async (blob) => {
                            if (blob && streamingRef.current) {
                                const arrayBuffer = await blob.arrayBuffer();
                                const byteArray = new Uint8Array(arrayBuffer);
                                
                                frameCount++;
                                if (frameCount % 30 === 0) {
                                    console.log(`📤 프레임 전송 #${frameCount}: ${byteArray.length} bytes`);
                                }
                                
                                try {
                                    await SendFrameData(Array.from(byteArray));
                                } catch (err) {
                                    console.error('❌ SendFrameData 실패:', err);
                                }
                            }
                        }, 'image/jpeg', 0.7);
                    }
                }
                
                // 다음 프레임 스케줄
                if (streamingRef.current) {
                    animationFrameRef.current = setTimeout(() => captureFrame(), 33) as unknown as number;
                }
            };

            // 비디오 준비 완료 후 캡처 시작
            videoElement.onloadeddata = () => {
                console.log('✅ 비디오 스트림 준비 완료, 캡처 시작');
                captureFrame();
            };

        } catch (err) {
            console.error("❌ 웹캠 접근 실패:", err);
            setChatLog(prevLog => [...prevLog, `System: Webcam access failed - ${err}`]);
            setIsStreaming(false);
            streamingRef.current = false;
        }
    };

    const handleStopStreaming = () => {
        console.log('⏹️ 스트리밍 중지');
        
        streamingRef.current = false;
        setIsStreaming(false);
        
        // 타이머 정리
        if (animationFrameRef.current) {
            clearTimeout(animationFrameRef.current);
        }
        
        // 미디어 스트림 중지
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => {
                console.log('🛑 트랙 중지:', track.label);
                track.stop();
            });
            mediaStreamRef.current = null;
        }
        
        // 비디오 요소 제거
        const videoElement = document.getElementById('streaming-video');
        if (videoElement) {
            videoElement.remove();
        }
        
        setChatLog(prevLog => [...prevLog, "System: Streaming stopped"]);
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
                    <img 
                        id="received-frame" 
                        style={{
                            width: '640px', 
                            height: '480px', 
                            border: '1px solid black',
                            backgroundColor: '#000'
                        }} 
                        alt="Received Stream"
                    />
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