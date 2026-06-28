import { useEffect, useRef, useState } from "react";
import { extractDTLSFingerprint } from "@/utils/fingerprint";

export type WebRTCCallMode = "audio" | "video";

interface UseWebRTCReturn {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  startCall: () => Promise<void>;
  stopCall: () => void;
  peerConnection: RTCPeerConnection | null;
  localFingerprint: string | null;
  remoteFingerprint: string | null;
}

interface TurnCredentialsResponse {
  urls: string[];
  username: string;
  credential: string;
  ttlSeconds?: number;
}

function resolveCallMode(mode: unknown): WebRTCCallMode {
  return mode === "video" ? "video" : "audio";
}

function createCallLogger(scope: string) {
  return (event: string, details?: unknown) => {
    if (details === undefined) {
      console.log(`[call:${scope}] ${event}`);
      return;
    }

    console.log(`[call:${scope}] ${event}`, details);
  };
}

function summarizeIceCandidate(candidate: RTCIceCandidate | RTCIceCandidateInit | null) {
  if (!candidate) {
    return null;
  }

  const candidateLine = candidate.candidate ?? "";
  const parts = candidateLine.split(" ");
  const typeIndex = parts.indexOf("typ");
  const protocol = parts[2] ?? null;

  return {
    candidate: candidateLine || null,
    protocol,
    type: typeIndex >= 0 ? parts[typeIndex + 1] ?? null : null,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

type StatsRecord = RTCStats & Record<string, unknown>;

function readStatString(record: StatsRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readStatNumber(record: StatsRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function readStatBoolean(record: StatsRecord | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function summarizeStatsCandidate(record: StatsRecord | null) {
  return {
    candidateType: readStatString(record, "candidateType"),
    protocol: readStatString(record, "protocol"),
    address: readStatString(record, "address"),
    port: readStatNumber(record, "port"),
    relayProtocol: readStatString(record, "relayProtocol"),
    url: readStatString(record, "url"),
  };
}

async function logSelectedCandidatePair(
  peerConnection: RTCPeerConnection,
  log: (event: string, details?: unknown) => void,
  reason: string,
) {
  try {
    const stats = await peerConnection.getStats();
    let selectedPair: StatsRecord | null = null;
    let localCandidate: StatsRecord | null = null;
    let remoteCandidate: StatsRecord | null = null;

    stats.forEach((report) => {
      const statsReport = report as StatsRecord;
      const selectedCandidatePairId = readStatString(
        statsReport,
        "selectedCandidatePairId",
      );

      if (report.type === "transport" && selectedCandidatePairId) {
        selectedPair = (stats.get(selectedCandidatePairId) as StatsRecord | undefined) ?? null;
      }
    });

    if (!selectedPair) {
      stats.forEach((report) => {
        const statsReport = report as StatsRecord;
        if (
          report.type === "candidate-pair" &&
          (readStatBoolean(statsReport, "selected") || readStatBoolean(statsReport, "nominated"))
        ) {
          selectedPair = statsReport;
        }
      });
    }

    if (!selectedPair || readStatString(selectedPair, "type") !== "candidate-pair") {
      log("candidate-pair unavailable", { reason });
      return;
    }

    const localCandidateId = readStatString(selectedPair, "localCandidateId");
    if (localCandidateId) {
      localCandidate = (stats.get(localCandidateId) as StatsRecord | undefined) ?? null;
    }

    const remoteCandidateId = readStatString(selectedPair, "remoteCandidateId");
    if (remoteCandidateId) {
      remoteCandidate = (stats.get(remoteCandidateId) as StatsRecord | undefined) ?? null;
    }

    log("selected candidate pair", {
      reason,
      connectionState: peerConnection.connectionState,
      iceConnectionState: peerConnection.iceConnectionState,
      iceGatheringState: peerConnection.iceGatheringState,
      pair: {
        state: readStatString(selectedPair, "state"),
        nominated: readStatBoolean(selectedPair, "nominated"),
        bytesSent: readStatNumber(selectedPair, "bytesSent"),
        bytesReceived: readStatNumber(selectedPair, "bytesReceived"),
        currentRoundTripTime: readStatNumber(selectedPair, "currentRoundTripTime"),
      },
      localCandidate: summarizeStatsCandidate(localCandidate),
      remoteCandidate: summarizeStatsCandidate(remoteCandidate),
    });
  } catch (error) {
    log("failed to inspect candidate pair", error);
  }
}

function isTurnCredentialsResponse(value: unknown): value is TurnCredentialsResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TurnCredentialsResponse>;
  return (
    Array.isArray(candidate.urls) &&
    candidate.urls.length > 0 &&
    candidate.urls.every((url) => typeof url === "string" && url.trim() !== "") &&
    typeof candidate.username === "string" &&
    candidate.username.trim() !== "" &&
    typeof candidate.credential === "string" &&
    candidate.credential.trim() !== ""
  );
}

async function fetchTurnIceServer(): Promise<RTCIceServer> {
  const response = await fetch("/api/turn-credentials", {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("turn_credentials_unavailable");
  }

  const payload: unknown = await response.json();
  if (!isTurnCredentialsResponse(payload)) {
    throw new Error("turn_credentials_invalid");
  }

  return {
    urls: payload.urls,
    username: payload.username,
    credential: payload.credential,
  };
}

export function useWebRTC(
  sendMessage: (message: any) => void,
  roomId: string,
  messages: any[],
  mode: WebRTCCallMode,
): UseWebRTCReturn {
  const logRef = useRef(createCallLogger(roomId));
  const myRoleRef = useRef<"initiator" | "receiver" | null>(null);
  const hasCreatedOfferRef = useRef(false);
  const hasReceivedOfferRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const isProcessingRef = useRef(false);
  const messageIndexRef = useRef(0);
  const disconnectTimerRef = useRef<number | null>(null);
  const isRestartingIceRef = useRef(false);
  const iceRestartAttemptsRef = useRef(0);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localFingerprint, setLocalFingerprint] = useState<string | null>(null);
  const [remoteFingerprint, setRemoteFingerprint] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>("new");
  const [peerConnectionReadyVersion, setPeerConnectionReadyVersion] = useState(0);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    logRef.current = createCallLogger(roomId);
  }, [roomId]);

  const updateLocalFingerprint = (sdp?: string | null) => {
    const nextFingerprint = extractDTLSFingerprint(sdp);
    if (nextFingerprint) {
      setLocalFingerprint(nextFingerprint);
    }
  };

  const updateRemoteFingerprint = (sdp?: string | null) => {
    const nextFingerprint = extractDTLSFingerprint(sdp);
    if (nextFingerprint) {
      setRemoteFingerprint(nextFingerprint);
    }
  };

  const clearDisconnectTimer = () => {
    if (disconnectTimerRef.current !== null) {
      window.clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  };

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const restartIce = async (_reason: string) => {
    const peerConnection = peerConnectionRef.current;
    const log = logRef.current;

    if (!peerConnection) {
      log("skip ICE restart", { reason: _reason, cause: "peer connection missing" });
      return;
    }

    if (myRoleRef.current !== "initiator") {
      log("skip ICE restart", { reason: _reason, cause: "not initiator", role: myRoleRef.current });
      return;
    }

    if (isRestartingIceRef.current) {
      log("skip ICE restart", { reason: _reason, cause: "restart already in progress" });
      return;
    }

    if (peerConnection.signalingState !== "stable") {
      log("skip ICE restart", {
        reason: _reason,
        cause: "signaling not stable",
        signalingState: peerConnection.signalingState,
      });
      return;
    }

    if (!peerConnection.remoteDescription) {
      log("skip ICE restart", { reason: _reason, cause: "remote description missing" });
      return;
    }

    isRestartingIceRef.current = true;
    iceRestartAttemptsRef.current += 1;
    log("restarting ICE", {
      reason: _reason,
      attempt: iceRestartAttemptsRef.current,
      signalingState: peerConnection.signalingState,
      connectionState: peerConnection.connectionState,
      iceConnectionState: peerConnection.iceConnectionState,
    });

    try {
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
      updateLocalFingerprint(peerConnection.localDescription?.sdp ?? offer.sdp);
      log("sending restart offer", {
        type: offer.type,
        sdpLength: offer.sdp?.length ?? 0,
      });
      sendMessage({
        type: "signal",
        roomId: roomId,
        data: { type: "offer", offer },
      });
    } catch (error) {
      log("ICE restart failed", error);
      console.error("Error restarting ICE:", error);
      isRestartingIceRef.current = false;
    }
  };

  useEffect(() => {
    setLocalFingerprint(null);
    setRemoteFingerprint(null);
    setConnectionState("new");
    peerConnectionRef.current = null;

    let isDisposed = false;
    let peerConnection: RTCPeerConnection | null = null;
    const log = logRef.current;

    const setupPeerConnection = async () => {
      try {
        const turnIceServer = await fetchTurnIceServer();
        if (isDisposed) {
          return;
        }

        log("creating peer connection", {
          mode,
          turnUrls: turnIceServer.urls,
          iceTransportPolicy: "relay",
        });

        peerConnection = new RTCPeerConnection({
          iceServers: [turnIceServer],
          iceTransportPolicy: "relay",
        });

        peerConnectionRef.current = peerConnection;

        peerConnection.onicecandidate = (event) => {
          if (!peerConnection) {
            return;
          }

          if (event.candidate) {
            log("local ICE candidate", summarizeIceCandidate(event.candidate));
            sendMessage({
              type: "signal",
              roomId: roomId,
              data: { type: "ice-candidate", candidate: event.candidate },
            });
          } else {
            log("local ICE gathering completed");
          }
        };

        peerConnection.onicecandidateerror = (event) => {
          log("ICE candidate error", {
            address: event.address,
            port: event.port,
            url: event.url,
            errorCode: event.errorCode,
            errorText: event.errorText,
          });
        };

        peerConnection.oniceconnectionstatechange = () => {
          if (!peerConnection) {
            return;
          }

          log("ice connection state", {
            iceConnectionState: peerConnection.iceConnectionState,
            connectionState: peerConnection.connectionState,
          });

          if (
            peerConnection.iceConnectionState === "connected" ||
            peerConnection.iceConnectionState === "completed" ||
            peerConnection.iceConnectionState === "failed"
          ) {
            void logSelectedCandidatePair(
              peerConnection,
              log,
              `ice:${peerConnection.iceConnectionState}`,
            );
          }
        };

        peerConnection.onicegatheringstatechange = () => {
          if (!peerConnection) {
            return;
          }

          log("ice gathering state", {
            iceGatheringState: peerConnection.iceGatheringState,
          });
        };

        peerConnection.onsignalingstatechange = () => {
          if (!peerConnection) {
            return;
          }

          log("signaling state", {
            signalingState: peerConnection.signalingState,
          });
        };

        peerConnection.onnegotiationneeded = () => {
          if (!peerConnection) {
            return;
          }

          log("negotiation needed", {
            signalingState: peerConnection.signalingState,
          });
        };

        peerConnection.ontrack = (event) => {
          log("remote track received", {
            streams: event.streams.map((stream) => ({
              id: stream.id,
              trackCount: stream.getTracks().length,
            })),
            track: {
              id: event.track.id,
              kind: event.track.kind,
              enabled: event.track.enabled,
              muted: event.track.muted,
              readyState: event.track.readyState,
            },
          });
          setRemoteStream(event.streams[0]);
        };

        peerConnection.onconnectionstatechange = () => {
          if (!peerConnection) {
            return;
          }

          setConnectionState(peerConnection.connectionState);
          log("peer connection state", {
            connectionState: peerConnection.connectionState,
            iceConnectionState: peerConnection.iceConnectionState,
            iceGatheringState: peerConnection.iceGatheringState,
            signalingState: peerConnection.signalingState,
          });

          if (
            peerConnection.connectionState === "connected" ||
            peerConnection.connectionState === "disconnected" ||
            peerConnection.connectionState === "failed"
          ) {
            void logSelectedCandidatePair(
              peerConnection,
              log,
              `connection:${peerConnection.connectionState}`,
            );
          }

          if (peerConnection.connectionState === "connected") {
            clearDisconnectTimer();
            isRestartingIceRef.current = false;
            iceRestartAttemptsRef.current = 0;
          }

          if (peerConnection.connectionState === "disconnected") {
            clearDisconnectTimer();
            disconnectTimerRef.current = window.setTimeout(() => {
              if (peerConnection?.connectionState === "disconnected") {
                void restartIce("disconnect timeout");
              }
              disconnectTimerRef.current = null;
            }, 5000);
          }

          if (peerConnection.connectionState === "failed") {
            clearDisconnectTimer();
            void restartIce("connection failed");
          }

          if (peerConnection.connectionState === "closed") {
            clearDisconnectTimer();
          }
        };

        setPeerConnectionReadyVersion((currentVersion) => currentVersion + 1);
      } catch (error) {
        if (isDisposed) {
          return;
        }

        log("failed to create peer connection", error);
        setConnectionState("failed");
      }
    };

    void setupPeerConnection();

    return () => {
      isDisposed = true;
      clearDisconnectTimer();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      if (peerConnection) {
        log("disposing peer connection", {
          connectionState: peerConnection.connectionState,
          iceConnectionState: peerConnection.iceConnectionState,
        });
        peerConnection.close();
      }
      if (peerConnectionRef.current === peerConnection) {
        peerConnectionRef.current = null;
      }
    };
  }, [roomId, sendMessage]);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const processMessages = async () => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        while (messageIndexRef.current < messagesRef.current.length) {
          const message = messagesRef.current[messageIndexRef.current];
          logRef.current("processing message", {
            index: messageIndexRef.current,
            type: message?.type,
            signalType: message?.data?.type,
          });

          if (message.type === "role") {
            if (!peerConnectionRef.current) {
              logRef.current("waiting for peer connection before processing role");
              return;
            }

            const assignedRole = message.data.role;
            const negotiatedMode = resolveCallMode(message.data.mode ?? mode);
            myRoleRef.current = assignedRole;
            logRef.current("received role assignment", {
              role: assignedRole,
              negotiatedMode,
            });

            const stream = await navigator.mediaDevices.getUserMedia({
              video: negotiatedMode === "video",
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            logRef.current("local media acquired", {
              streamId: stream.id,
              audioTracks: stream.getAudioTracks().length,
              videoTracks: stream.getVideoTracks().length,
            });
            stream.getAudioTracks().forEach((track) => (track.enabled = false));
            if (negotiatedMode === "video") {
              stream.getVideoTracks().forEach((track) => (track.enabled = false));
            }
            setLocalStream(stream);
            stream.getTracks().forEach((track) => {
              peerConnectionRef.current?.addTrack(track, stream);
            });

            if (assignedRole === "initiator") {
              logRef.current("sending initiator arrived signal");
              sendMessage({
                type: "signal",
                roomId: roomId,
                data: { type: "initiator_arrived" },
              });
            } else {
              logRef.current("sending peer ready signal");
              sendMessage({
                type: "signal",
                roomId: roomId,
                data: { type: "peer_ready" },
              });
            }
          } else if (
            message.type === "signal" &&
            message.data.type === "peer_ready"
          ) {
            if (myRoleRef.current === "initiator") {
              if (!hasCreatedOfferRef.current) {
                logRef.current("peer ready received, creating initial offer");
                await startCall();
              }
            }
          } else if (
            message.type === "signal" &&
            message.data.type === "initiator_arrived"
          ) {
            if (myRoleRef.current === "receiver") {
              logRef.current("initiator arrived, sending peer ready");
              sendMessage({
                type: "signal",
                roomId: roomId,
                data: { type: "peer_ready" },
              });
            }
          } else if (message.type === "peer-status") {
            if (myRoleRef.current === "initiator" && !hasCreatedOfferRef.current) {
              logRef.current("peer status received before offer, creating initial offer");
              await startCall();
            }
          } else if (
            message.type === "signal" &&
            message.data.type === "offer"
          ) {
            hasReceivedOfferRef.current = true;
            isRestartingIceRef.current = false;
            logRef.current("received offer", {
              sdpLength: message.data.offer?.sdp?.length ?? 0,
            });
            updateRemoteFingerprint(message.data.offer?.sdp);
            await peerConnectionRef.current?.setRemoteDescription(
              new RTCSessionDescription(message.data.offer),
            );
            logRef.current("remote offer applied");
            await flushIceQueue();
            const answer = await peerConnectionRef.current?.createAnswer();
            await peerConnectionRef.current?.setLocalDescription(answer);
            updateLocalFingerprint(
              peerConnectionRef.current?.localDescription?.sdp ?? answer?.sdp,
            );
            logRef.current("sending answer", {
              sdpLength: answer?.sdp?.length ?? 0,
            });
            sendMessage({
              type: "signal",
              roomId: roomId,
              data: { type: "answer", answer },
            });
          } else if (
            message.type === "signal" &&
            message.data.type === "answer"
          ) {
            isRestartingIceRef.current = false;
            logRef.current("received answer", {
              sdpLength: message.data.answer?.sdp?.length ?? 0,
            });
            updateRemoteFingerprint(message.data.answer?.sdp);
            await peerConnectionRef.current?.setRemoteDescription(
              new RTCSessionDescription(message.data.answer),
            );
            logRef.current("remote answer applied");
            await flushIceQueue();
          } else if (
            message.type === "signal" &&
            message.data.type === "ice-candidate"
          ) {
            if (peerConnectionRef.current?.remoteDescription) {
              logRef.current("applying remote ICE candidate", summarizeIceCandidate(message.data.candidate));
              await peerConnectionRef.current?.addIceCandidate(
                new RTCIceCandidate(message.data.candidate),
              );
            } else {
              logRef.current("queueing remote ICE candidate", summarizeIceCandidate(message.data.candidate));
              pendingCandidatesRef.current.push(message.data.candidate);
            }
          }

          messageIndexRef.current++;
        }
      } finally {
        isProcessingRef.current = false;
        if (messageIndexRef.current < messagesRef.current.length) {
          void processMessages();
        }
      }
    };

    void processMessages();
  }, [messages, mode, roomId, sendMessage, peerConnectionReadyVersion]);

  const flushIceQueue = async () => {
    if (pendingCandidatesRef.current.length > 0) {
      logRef.current("flushing queued ICE candidates", {
        count: pendingCandidatesRef.current.length,
      });
    }
    for (const candidate of pendingCandidatesRef.current) {
      try {
        await peerConnectionRef.current?.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
        logRef.current("queued ICE candidate applied", summarizeIceCandidate(candidate));
      } catch (error) {
        logRef.current("queued ICE candidate failed", {
          candidate: summarizeIceCandidate(candidate),
          error,
        });
        console.error("Error adding queued ICE candidate", error);
      }
    }
    pendingCandidatesRef.current = [];
  };

  const startCall = async () => {
    try {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) {
        logRef.current("offer creation skipped", {
          reason: "peer connection missing",
        });
        return;
      }

      if (myRoleRef.current === "initiator" && !hasCreatedOfferRef.current) {
        logRef.current("creating offer", {
          role: myRoleRef.current,
        });
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        updateLocalFingerprint(
          peerConnection.localDescription?.sdp ?? offer.sdp,
        );
        logRef.current("sending offer", {
          sdpLength: offer.sdp?.length ?? 0,
        });
        sendMessage({
          type: "signal",
          roomId: roomId,
          data: { type: "offer", offer },
        });
        hasCreatedOfferRef.current = true;
      }
    } catch (error) {
      logRef.current("offer creation failed", error);
      console.error("Error creating offer:", error);
    }
  };

  const stopCall = () => {
    logRef.current("stopping call", {
      connectionState: peerConnectionRef.current?.connectionState ?? "closed",
    });
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    peerConnectionRef.current?.close();
    setLocalStream(null);
    setRemoteStream(null);
    setLocalFingerprint(null);
    setRemoteFingerprint(null);
  };

  return {
    localStream,
    remoteStream,
    connectionState,
    startCall,
    stopCall,
    peerConnection: peerConnectionRef.current,
    localFingerprint,
    remoteFingerprint,
  };
}
