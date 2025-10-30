// p2p.go
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"encoding/binary"

	"github.com/gorilla/websocket"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	// *** 스트리밍을 위한 Pion 라이브러리 추가 ***
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// RTPSendFactory는 Factory 인터페이스를 구현합니다
type RTPSendFactory struct{}

func (f *RTPSendFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	return &RTPSendInterceptor{}, nil
}

// RTPSendInterceptor는 Interceptor 인터페이스를 구현합니다
type RTPSendInterceptor struct {
	interceptor.NoOp
}

func (i *RTPSendInterceptor) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	return &RTPSendWriter{
		writer: writer,
	}
}

type RTPSendWriter struct {
	writer interceptor.RTPWriter
}

func (w *RTPSendWriter) Write(header *rtp.Header, payload []byte, a interceptor.Attributes) (int, error) {
	// 헤더와 페이로드를 합쳐서 RTP 패킷 생성
	packet := &rtp.Packet{
		Header:  *header,
		Payload: payload,
	}

	b, err := packet.Marshal()
	if err != nil {
		return 0, err
	}

	peersMux.Lock()
	defer peersMux.Unlock()

	if len(peers) > 0 {
		for _, peerAddr := range peers {
			if _, err := udpConn.WriteToUDP(b, peerAddr); err != nil {
				log.Printf("RTP 패킷 전송 실패: %v", err)
			}
		}
	}

	// 원래 writer에도 전달
	return w.writer.Write(header, payload, a)
}

// --- 구조체 및 전역 변수 ---
type ClientInfo struct {
	PublicIP  string `json:"public_ip"`
	PrivateIP string `json:"private_ip"`
	Port      string `json:"port"`
}

var (
	udpConn         *net.UDPConn
	myInfo          ClientInfo
	peers           = make(map[string]*net.UDPAddr) // key: "ip:port" 문자열
	peersMux        = &sync.Mutex{}
	ws              *websocket.Conn
	frameBuffers    = make(map[uint32]map[uint16][]byte) // frameID -> chunkID -> data
	frameBuffersMux = &sync.Mutex{}
)

const (
	MaxUDPPacketSize = 1400 // 안전한 UDP 패킷 크기
)

// 프레임 헤더 구조
type FrameHeader struct {
	FrameID     uint32 // 프레임 식별자
	ChunkID     uint16 // 현재 청크 번호
	TotalChunks uint16 // 전체 청크 개수
}

// --- 프런트엔드에서 호출될 함수들 ---

// 앱 시작 시 P2P 환경 초기화
func (a *App) startupP2P() {
	var err error
	udpConn, err = net.ListenUDP("udp", &net.UDPAddr{Port: 0})
	if err != nil {
		log.Fatalf("UDP 리스너 시작 실패: %v", err)
	}

	myInfo.Port = strconv.Itoa(udpConn.LocalAddr().(*net.UDPAddr).Port)
	myInfo.PrivateIP = getPrivateIP()
	myInfo.PublicIP = getPublicIP()
	log.Printf("내 정보 - 공인IP: %s, 사설IP: %s, 포트: %s", myInfo.PublicIP, myInfo.PrivateIP, myInfo.Port)

	go listenUDP(a.ctx)
}

// 특정 방에 참여
func (a *App) JoinRoom(roomName string) string {
	if ws != nil {
		ws.Close() // 다른 방에 접속 시 기존 연결 종료
	}
	if roomName == "" {
		return "방 이름이 비어있습니다."
	}
	serverAddr := fmt.Sprintf("ws://solana1000.synology.me:8080/ws?room=%s", roomName)
	log.Printf("'%s' 방에 접속 시도...", roomName)

	var err error
	ws, _, err = websocket.DefaultDialer.Dial(serverAddr, nil)
	if err != nil {
		return fmt.Sprintf("서버 접속 실패: %v", err)
	}
	log.Println("시그널링 서버에 접속 성공")

	if err := ws.WriteJSON(myInfo); err != nil {
		return fmt.Sprintf("정보 전송 실패: %v", err)
	}

	go listenWebSocket(a.ctx)
	return fmt.Sprintf("'%s' 방에 성공적으로 참여했습니다.", roomName)
}

// 연결된 모든 피어에게 메시지 전송
func (a *App) SendMessage(text string) {
	peersMux.Lock()
	defer peersMux.Unlock()

	if len(peers) == 0 {
		log.Println("아직 연결된 피어가 없습니다.")
	} else {
		log.Printf("%d명의 피어에게 메시지 전송: %s", len(peers), text)
		for _, peerAddr := range peers {
			udpConn.WriteToUDP([]byte(text), peerAddr)
		}
	}
}

func (a *App) SendFrameData(frameData []byte) {
	peersMux.Lock()
	defer peersMux.Unlock()

	if len(peers) == 0 {
		return
	}

	// 프레임을 청크로 분할
	frameID := uint32(time.Now().UnixNano() / 1000000) // 밀리초 단위 타임스탬프
	dataSize := len(frameData)
	headerSize := 8 // FrameID(4) + ChunkID(2) + TotalChunks(2)
	chunkDataSize := MaxUDPPacketSize - headerSize
	totalChunks := (dataSize + chunkDataSize - 1) / chunkDataSize

	log.Printf("📤 프레임 전송: %d bytes → %d chunks", dataSize, totalChunks)

	for chunkID := 0; chunkID < totalChunks; chunkID++ {
		start := chunkID * chunkDataSize
		end := start + chunkDataSize
		if end > dataSize {
			end = dataSize
		}

		// 헤더 생성
		packet := make([]byte, headerSize+end-start)
		binary.BigEndian.PutUint32(packet[0:4], frameID)
		binary.BigEndian.PutUint16(packet[4:6], uint16(chunkID))
		binary.BigEndian.PutUint16(packet[6:8], uint16(totalChunks))
		copy(packet[8:], frameData[start:end])

		// 모든 피어에게 전송
		for peerAddrStr, peerAddr := range peers {
			_, err := udpConn.WriteToUDP(packet, peerAddr)
			if err != nil {
				log.Printf("❌ 청크 %d/%d 전송 실패 (%s): %v", chunkID+1, totalChunks, peerAddrStr, err)
			}
		}
	}
}

func (a *App) StartStreaming() {
	log.Println("스트리밍 전송을 시작합니다...")

	i := &interceptor.Registry{}
	i.Add(&RTPSendFactory{})

	api := webrtc.NewAPI(webrtc.WithInterceptorRegistry(i))

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		panic(err)
	}
	defer pc.Close()

	// 비디오 트랙 생성
	videoTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"video",
		"pion",
	)
	if err != nil {
		panic(err)
	}

	rtpSender, err := pc.AddTrack(videoTrack)
	if err != nil {
		panic(err)
	}

	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, rtcpErr := rtpSender.Read(rtcpBuf); rtcpErr != nil {
				return
			}
		}
	}()

	// 웹캠 스트림 시작
	go streamWebcamWithPion(videoTrack, a.ctx)
}

func streamWebcamWithPion(videoTrack *webrtc.TrackLocalStaticRTP, ctx context.Context) {
	// VP8 인코더 설정
	// vpxParams, err := vpx.NewVP8Params()
	// if err != nil {
	// 	log.Printf("VP8 파라미터 생성 실패: %v", err)
	// 	return
	// }
	// vpxParams.BitRate = 1_000_000 // 1mbps

	// codecSelector := mediadevices.NewCodecSelector(
	// 	mediadevices.WithVideoEncoders(&vpxParams),
	// )

	// // 웹캠 스트림 시작
	// mediaStream, err := mediadevices.GetUserMedia(mediadevices.MediaStreamConstraints{
	// 	Video: func(c *mediadevices.MediaTrackConstraints) {
	// 		c.Width = prop.Int(1280)
	// 		c.Height = prop.Int(720)
	// 	},
	// 	Codec: codecSelector,
	// })
	// if err != nil {
	// 	log.Printf("웹캠 접근 실패: %v", err)
	// 	return
	// }

	// log.Println("웹캠 스트림 시작...")

	// videoTracks := mediaStream.GetVideoTracks()
	// if len(videoTracks) == 0 {
	// 	log.Println("비디오 트랙을 찾을 수 없습니다")
	// 	return
	// }

	// track := videoTracks[0]
	// defer track.Close()

	// // RTP Reader 생성
	// rtpReader, err := track.NewRTPReader(vpxParams.RTPCodec().MimeType, rand.Uint32(), 1000)
	// if err != nil {
	// 	log.Printf("RTP Reader 생성 실패: %v", err)
	// 	return
	// }

	// for {
	// 	select {
	// 	case <-ctx.Done():
	// 		log.Println("스트리밍 중지됨")
	// 		return
	// 	default:
	// 	}

	// 	pkts, release, err := rtpReader.Read()
	// 	if err != nil {
	// 		log.Printf("RTP 읽기 실패: %v", err)
	// 		return
	// 	}

	// 	for _, pkt := range pkts {
	// 		if err := videoTrack.WriteRTP(pkt); err != nil {
	// 			log.Printf("RTP 전송 실패: %v", err)
	// 			release()
	// 			return
	// 		}
	// 	}
	// 	release()
	// }
}

// --- 내부 동작 함수들 ---

// 서버로부터 피어 목록을 실시간으로 수신 및 처리
func listenWebSocket(ctx context.Context) {
	defer ws.Close()
	for {
		var receivedPeers []ClientInfo
		if err := ws.ReadJSON(&receivedPeers); err != nil {
			log.Println("WebSocket 연결이 끊어졌습니다:", err)
			runtime.EventsEmit(ctx, "peer-list-updated", []ClientInfo{})
			return
		}

		peersMux.Lock()
		activePeers := make(map[string]bool)

		// 서버가 보내준 최신 목록을 기준으로 연결 시도
		for _, peerInfo := range receivedPeers {
			var targetIP string
			if myInfo.PublicIP != "" && myInfo.PublicIP == peerInfo.PublicIP {
				targetIP = peerInfo.PrivateIP
			} else {
				targetIP = peerInfo.PublicIP
			}
			peerAddrStr := targetIP + ":" + peerInfo.Port
			activePeers[peerAddrStr] = true

			// 아직 연결 목록에 없는 새로운 피어라면 연결 시도
			if _, exists := peers[peerAddrStr]; !exists {
				go connectToPeer(peerAddrStr)
			}
		}

		// 최신 목록에 없는 피어는 연결 목록에서 제거 (나간 사용자 처리)
		for addrStr := range peers {
			if !activePeers[addrStr] {
				log.Printf("피어 연결 해제: %s", addrStr)
				delete(peers, addrStr)
			}
		}
		peersMux.Unlock()

		// 프런트엔드 UI에 최신 피어 목록 전달
		runtime.EventsEmit(ctx, "peer-list-updated", receivedPeers)
	}
}

// 특정 피어에게 UDP 홀 펀칭 시도
func connectToPeer(addrStr string) {
	peerAddr, err := net.ResolveUDPAddr("udp", addrStr)
	if err != nil {
		log.Printf("주소 (%s) 해석 실패: %v", addrStr, err)
		return
	}
	log.Printf("새로운 피어(%s)에게 홀 펀칭 시도...", addrStr)
	for i := 0; i < 10; i++ {
		udpConn.WriteToUDP([]byte("펀칭!"), peerAddr)
		time.Sleep(100 * time.Millisecond)
	}
}

func getPrivateIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

func getPublicIP() string {
	resp, err := http.Get("https://api.ipify.org?format=text")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(body))
}

// listenUDP 함수 수정
func listenUDP(ctx context.Context) {
	buffer := make([]byte, MaxUDPPacketSize+100)

	for {
		n, addr, err := udpConn.ReadFromUDP(buffer)
		if err != nil {
			return
		}

		addrStr := addr.String()

		peersMux.Lock()
		if _, exists := peers[addrStr]; !exists {
			log.Printf("새로운 피어(%s)로부터 첫 응답! 연결 목록에 추가.", addrStr)
			peers[addrStr] = addr
		}
		peersMux.Unlock()

		// 최소 헤더 크기 확인
		if n < 8 {
			msg := string(buffer[:n])
			if !strings.Contains(msg, "펀칭!") {
				runtime.EventsEmit(ctx, "new-message-received", map[string]string{
					"sender":  addrStr,
					"message": msg,
				})
			}
			continue
		}

		// 프레임 데이터인지 확인 (헤더 파싱 시도)
		frameID := binary.BigEndian.Uint32(buffer[0:4])
		chunkID := binary.BigEndian.Uint16(buffer[4:6])
		totalChunks := binary.BigEndian.Uint16(buffer[6:8])
		chunkData := buffer[8:n]

		// 텍스트 메시지 필터링
		if totalChunks == 0 || totalChunks > 1000 {
			msg := string(buffer[:n])
			if !strings.Contains(msg, "펀칭!") {
				runtime.EventsEmit(ctx, "new-message-received", map[string]string{
					"sender":  addrStr,
					"message": msg,
				})
			}
			continue
		}

		// 청크 수집
		frameBuffersMux.Lock()
		if frameBuffers[frameID] == nil {
			frameBuffers[frameID] = make(map[uint16][]byte)
		}
		frameBuffers[frameID][chunkID] = make([]byte, len(chunkData))
		copy(frameBuffers[frameID][chunkID], chunkData)

		// 모든 청크가 도착했는지 확인
		if len(frameBuffers[frameID]) == int(totalChunks) {
			// ✅ 청크를 순서대로 재조립 (매우 중요!)
			var completeFrame []byte
			for i := uint16(0); i < totalChunks; i++ {
				chunk, exists := frameBuffers[frameID][i]
				if !exists {
					log.Printf("❌ 청크 %d/%d 누락! 프레임 %d 버림", i, totalChunks, frameID)
					delete(frameBuffers, frameID)
					frameBuffersMux.Unlock()
					continue
				}
				completeFrame = append(completeFrame, chunk...)
			}

			// 오래된 버퍼 정리
			delete(frameBuffers, frameID)

			// ✅ JPEG 매직 넘버 확인
			if len(completeFrame) > 0 && isImageData(completeFrame) {
				log.Printf("📥 프레임 완성: %d bytes (%d chunks) from %s - JPEG 시작: %02X %02X %02X",
					len(completeFrame), totalChunks, addrStr, completeFrame[0], completeFrame[1], completeFrame[2])
				runtime.EventsEmit(ctx, "frame-received", completeFrame)
			} else {
				log.Printf("❌ 잘못된 이미지 데이터: %d bytes, 시작: %02X %02X %02X",
					len(completeFrame), completeFrame[0], completeFrame[1], completeFrame[2])
			}
		}
		frameBuffersMux.Unlock()
	}
}

// 이미지 데이터인지 확인
func isImageData(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	// PNG 매직 넘버: 89 50 4E 47
	if data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47 {
		return true
	}
	// JPEG 매직 넘버: FF D8 FF
	if data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return true
	}
	return false
}
