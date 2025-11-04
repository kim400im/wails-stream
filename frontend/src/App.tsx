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
    
    const streamingRef = useRef(false);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number>(0);
    
    // ✅ Canvas ref 추가
    const receivedCanvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const cleanupMsgListener = EventsOn('new-message-received', (data: MessageData) => {
            if (data.message.includes('펀칭!')) return;
            setChatLog(prevLog => [...prevLog, `[${data.sender}]: ${data.message}`]);
        });

        const cleanupPeerListener = EventsOn('peer-list-updated', (peers: ClientInfo[]) => {
            console.log('📡 피어 목록 업데이트:', peers);
            setPeerList(peers || []);
        });

        // ✅ Canvas로 프레임 렌더링
        const cleanupFrameListener = EventsOn('frame-received', (frameData: any) => {
            try {
                // ✅ frameData가 string인 경우 (Base64)
                if (typeof frameData === 'string') {
                    console.log(`📥 프레임 수신: ${frameData.length} chars (Base64)`);
                    
                    // Base64 디코딩
                    const decodedString = atob(frameData);
                    const uint8Array = new Uint8Array(decodedString.length);
                    
                    for (let i = 0; i < decodedString.length; i++) {
                        uint8Array[i] = decodedString.charCodeAt(i);
                    }
                    
                    console.log(`✅ 디코딩 완료: ${uint8Array.length} bytes`);
                    console.log(`🔍 매직 넘버: ${uint8Array[0].toString(16)} ${uint8Array[1].toString(16)} ${uint8Array[2].toString(16)}`);
                    
                    // JPEG 검증
                    if (uint8Array[0] !== 0xFF || uint8Array[1] !== 0xD8) {
                        console.error('❌ JPEG 시그니처 불일치!');
                        return;
                    }
                    
                    // 이미지 렌더링
                    const blob = new Blob([uint8Array], { type: 'image/jpeg' });
                    const url = URL.createObjectURL(blob);
                    
                    const img = new Image();
                    img.onload = () => {
                        console.log('✅ 이미지 로드 성공:', img.width, 'x', img.height);
                        const canvas = receivedCanvasRef.current;
                        if (canvas) {
                            const ctx = canvas.getContext('2d');
                            if (ctx) {
                                if (canvas.width === 0) {
                                    canvas.width = img.width;
                                    canvas.height = img.height;
                                }
                                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                            }
                        }
                        URL.revokeObjectURL(url);
                    };
                    img.onerror = (e) => {
                        console.error('❌ 이미지 로드 실패:', e);
                        URL.revokeObjectURL(url);
                    };
                    img.src = url;
                }
                // ✅ 숫자 배열인 경우 (혹시 몰라서)
                else if (Array.isArray(frameData)) {
                    console.log(`📥 프레임 수신: ${frameData.length} bytes (array)`);
                    const uint8Array = new Uint8Array(frameData);
                    
                    console.log(`🔍 매직 넘버: ${uint8Array[0].toString(16)} ${uint8Array[1].toString(16)} ${uint8Array[2].toString(16)}`);
                    
                    // JPEG 검증
                    if (uint8Array[0] !== 0xFF || uint8Array[1] !== 0xD8) {
                        console.error('❌ JPEG 시그니처 불일치!');
                        return;
                    }
                    
                    // 이미지 렌더링
                    const blob = new Blob([uint8Array], { type: 'image/jpeg' });
                    const url = URL.createObjectURL(blob);
                    
                    const img = new Image();
                    img.onload = () => {
                        console.log('✅ 이미지 로드 성공:', img.width, 'x', img.height);
                        const canvas = receivedCanvasRef.current;
                        if (canvas) {
                            const ctx = canvas.getContext('2d');
                            if (ctx) {
                                if (canvas.width === 0) {
                                    canvas.width = img.width;
                                    canvas.height = img.height;
                                }
                                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                            }
                        }
                        URL.revokeObjectURL(url);
                    };
                    img.onerror = (e) => {
                        console.error('❌ 이미지 로드 실패:', e);
                        URL.revokeObjectURL(url);
                    };
                    img.src = url;
                }
                
            } catch (err) {
                console.error('❌ 프레임 처리 실패:', err);
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

                if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
                    if (ctx) {
                        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
                        
                        canvas.toBlob(async (blob) => {
                            if (blob && streamingRef.current) {
                                // ✅ 방법 1: ArrayBuffer → number[] 확실하게
                                const arrayBuffer = await blob.arrayBuffer();
                                const uint8Array = new Uint8Array(arrayBuffer);
                                const numberArray: number[] = [];
                                
                                for (let i = 0; i < uint8Array.length; i++) {
                                    numberArray.push(uint8Array[i]);
                                }
                                
                                frameCount++;
                                if (frameCount % 30 === 0) {
                                    console.log(`📤 전송 준비: ${numberArray.length} bytes`);
                                    console.log(`🔍 첫 3바이트: ${numberArray[0].toString(16)} ${numberArray[1].toString(16)} ${numberArray[2].toString(16)}`);
                                }
                                
                                try {
                                    await SendFrameData(numberArray);
                                } catch (err) {
                                    console.error('❌ SendFrameData 실패:', err);
                                }
                            }
                        }, 'image/jpeg', 0.6);
                    }
                }
                
                if (streamingRef.current) {
                    animationFrameRef.current = setTimeout(() => captureFrame(), 33) as unknown as number;
                }
            };

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
        
        if (animationFrameRef.current) {
            clearTimeout(animationFrameRef.current);
        }
        
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => {
                console.log('🛑 트랙 중지:', track.label);
                track.stop();
            });
            mediaStreamRef.current = null;
        }
        
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
                    {/* ✅ img 태그 대신 canvas 사용 */}
                    <canvas 
                        ref={receivedCanvasRef}
                        width={640}
                        height={480}
                        style={{
                            width: '640px', 
                            height: '480px', 
                            border: '1px solid black',
                            backgroundColor: '#000'
                        }} 
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