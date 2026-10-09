"""Character Voice Agent - FastAPI server.

Serves the frontend from public/ and exposes a WebSocket that drives the
character with Amazon Nova Lite (text + emotion) and Amazon Polly (voice +
viseme timings for lip sync).

Loads AWS keys from .env when present, but also runs without .env (on the
deployment server boto3 uses the instance's IAM role). AWS region is always
us-east-1 and is passed explicitly to every AWS client.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

# Load .env if it exists; absence is fine (server uses its own AWS role).
load_dotenv()

import boto3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from langchain_aws import ChatBedrockConverse
from langchain_core.messages import SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph

from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler

AWS_REGION = "us-east-1"
MODEL_ID = "us.amazon.nova-lite-v1:0"
MAX_INPUT_CHARS = 500
MAX_HISTORY_MESSAGES = 20  # keep the last ~20 messages per conversation

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
CHARACTER_FILE = BASE_DIR / "character.json"


# ---------------------------------------------------------------------------
# Character config
# ---------------------------------------------------------------------------
def load_character() -> dict:
    if CHARACTER_FILE.exists():
        return json.loads(CHARACTER_FILE.read_text(encoding="utf-8"))
    return {}


CHARACTER = load_character()
CHARACTER_NAME = CHARACTER.get("name", "the character")
PERSONALITY = CHARACTER.get("personality", "You are a friendly character.")
VOICE = CHARACTER.get("voice", {"id": "Matthew", "engine": "neural"})

SYSTEM_PROMPT = (
    f"{PERSONALITY}\n\n"
    f"Your name is {CHARACTER_NAME}. Stay fully in character at all times. "
    "Reply with 1 to 3 short sentences. Do not use lists, bullet points, "
    "markdown, or emojis. Choose an emotion that fits your reply from: "
    "neutral, happy, angry, sad, relaxed."
)


# ---------------------------------------------------------------------------
# Reply model (structured output from Nova Lite)
# ---------------------------------------------------------------------------
class Reply(BaseModel):
    text: str = Field(description="The reply, 1 to 3 short sentences, no lists or emojis.")
    emotion: Literal["neutral", "happy", "angry", "sad", "relaxed"] = Field(
        description="The emotion that best fits the reply."
    )


# ---------------------------------------------------------------------------
# LangGraph agent (Nova Lite + memory)
# ---------------------------------------------------------------------------
llm = ChatBedrockConverse(
    model=MODEL_ID,
    region_name=AWS_REGION,
    temperature=0.7,
)
structured_llm = llm.with_structured_output(Reply)


class AgentState(MessagesState):
    # Plain, serializable fields carrying the latest reply out of the graph.
    last_text: str
    last_emotion: str


def call_model(state: AgentState) -> dict:
    # Keep the system prompt + the last ~20 messages for context.
    history = state["messages"][-MAX_HISTORY_MESSAGES:]
    messages = [SystemMessage(content=SYSTEM_PROMPT), *history]
    reply: Reply = structured_llm.invoke(messages)
    # Store the assistant text in memory, plus the emotion as a plain string
    # (avoid putting a Pydantic object into the checkpoint).
    return {
        "messages": [{"role": "assistant", "content": reply.text}],
        "last_text": reply.text,
        "last_emotion": reply.emotion,
    }


_builder = StateGraph(AgentState)
_builder.add_node("call_model", call_model)
_builder.add_edge(START, "call_model")
_graph = _builder.compile(checkpointer=InMemorySaver())


def generate_reply(thread_id: str, user_text: str) -> Reply:
    """Run the agent for one user turn and return the structured Reply.

    The graph appends the user message to the per-thread memory, calls Nova
    Lite once with structured output, and keeps the last ~20 messages so the
    conversation is remembered.
    """
    config = {"configurable": {"thread_id": thread_id}}
    state = _graph.invoke(
        {"messages": [{"role": "user", "content": user_text}]}, config
    )
    return Reply(text=state["last_text"], emotion=state["last_emotion"])


# ---------------------------------------------------------------------------
# Amazon Polly (voice + viseme timings)
# ---------------------------------------------------------------------------
polly = boto3.client("polly", region_name=AWS_REGION)


def _synth_mp3(text: str) -> bytes:
    resp = polly.synthesize_speech(
        Text=text,
        OutputFormat="mp3",
        VoiceId=VOICE.get("id", "Matthew"),
        Engine=VOICE.get("engine", "neural"),
    )
    return resp["AudioStream"].read()


def _synth_visemes(text: str) -> list[dict]:
    resp = polly.synthesize_speech(
        Text=text,
        OutputFormat="json",
        VoiceId=VOICE.get("id", "Matthew"),
        Engine=VOICE.get("engine", "neural"),
        SpeechMarkTypes=["viseme", "word"],
    )
    raw = resp["AudioStream"].read().decode("utf-8")
    visemes = []
    for line in raw.strip().splitlines():
        if not line:
            continue
        mark = json.loads(line)
        if mark.get("type") == "viseme":
            visemes.append({"time": mark["time"], "value": mark["value"]})
    return visemes


async def synthesize(text: str) -> tuple[str, list[dict]]:
    """Call Polly twice in parallel: mp3 (base64) + viseme timings."""
    mp3_bytes, visemes = await asyncio.gather(
        asyncio.to_thread(_synth_mp3, text),
        asyncio.to_thread(_synth_visemes, text),
    )
    return base64.b64encode(mp3_bytes).decode("ascii"), visemes


# ---------------------------------------------------------------------------
# Amazon Transcribe (streaming speech-to-text) - Bonus A
# ---------------------------------------------------------------------------
# One streaming client, reused across requests.
_transcribe_client = TranscribeStreamingClient(region=AWS_REGION)


class _TranscriptCollector(TranscriptResultStreamHandler):
    """Collects partial/final transcripts and forwards partials to the browser."""

    def __init__(self, output_stream, ws: WebSocket, loop):
        super().__init__(output_stream)
        self._ws = ws
        self._loop = loop
        self.final_text = ""

    async def handle_transcript_event(self, transcript_event) -> None:
        for result in transcript_event.transcript.results:
            if not result.alternatives:
                continue
            text = result.alternatives[0].transcript
            if result.is_partial:
                # Live words while the user is still talking.
                try:
                    await self._ws.send_json(
                        {"type": "transcript", "text": text, "partial": True}
                    )
                except Exception:  # noqa: BLE001
                    pass
            else:
                # Finalized segment; accumulate.
                self.final_text = (self.final_text + " " + text).strip()
                try:
                    await self._ws.send_json(
                        {"type": "transcript", "text": self.final_text, "partial": False}
                    )
                except Exception:  # noqa: BLE001
                    pass


class MicSession:
    """One live microphone -> Transcribe streaming session."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.stream = None
        self.handler: _TranscriptCollector | None = None
        self._handler_task: asyncio.Task | None = None

    async def start(self) -> None:
        self.stream = await _transcribe_client.start_stream_transcription(
            language_code="en-US",
            media_sample_rate_hz=16000,
            media_encoding="pcm",
        )
        loop = asyncio.get_running_loop()
        self.handler = _TranscriptCollector(self.stream.output_stream, self.ws, loop)
        self._handler_task = asyncio.create_task(self.handler.handle_events())

    async def send_audio(self, pcm: bytes) -> None:
        if self.stream is not None:
            await self.stream.input_stream.send_audio_event(audio_chunk=pcm)

    async def stop(self) -> str:
        """Close the input stream and return the final transcript."""
        if self.stream is not None:
            # Closing the input stream signals end-of-audio to Transcribe.
            await self.stream.input_stream.end_stream()
        if self._handler_task is not None:
            try:
                await asyncio.wait_for(self._handler_task, timeout=10)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                self._handler_task.cancel()
        text = self.handler.final_text if self.handler else ""
        self.stream = None
        self.handler = None
        self._handler_task = None
        return text


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Character Voice Agent")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/character")
async def character() -> JSONResponse:
    """Return character.json WITHOUT the personality (that stays server-side)."""
    if not CHARACTER_FILE.exists():
        return JSONResponse({}, status_code=200)
    data = json.loads(CHARACTER_FILE.read_text(encoding="utf-8"))
    data.pop("personality", None)
    return JSONResponse(data)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "index.html")


async def _handle_turn(ws: WebSocket, thread_id: str, user_text: str) -> None:
    """Generate a reply + voice and send it to the browser."""
    user_text = (user_text or "").strip()[:MAX_INPUT_CHARS]
    if not user_text:
        return
    reply = await asyncio.to_thread(generate_reply, thread_id, user_text)
    audio_b64, visemes = await synthesize(reply.text)
    await ws.send_json(
        {
            "type": "reply",
            "text": reply.text,
            "emotion": reply.emotion,
            "audio": audio_b64,
            "visemes": visemes,
        }
    )


async def _speak_greeting(ws: WebSocket) -> None:
    greeting = CHARACTER.get("greeting")
    if not greeting:
        return
    try:
        audio_b64, visemes = await synthesize(greeting)
        await ws.send_json(
            {
                "type": "reply",
                "text": greeting,
                "emotion": "happy",
                "audio": audio_b64,
                "visemes": visemes,
            }
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[/ws] greeting error: {exc!r}")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    thread_id = str(uuid.uuid4())  # one conversation per WebSocket
    mic: MicSession | None = None
    try:
        while True:
            event = await ws.receive()

            # Binary frame = raw 16kHz PCM audio while recording.
            if "bytes" in event and event["bytes"] is not None:
                if mic is not None:
                    try:
                        await mic.send_audio(event["bytes"])
                    except Exception as exc:  # noqa: BLE001
                        print(f"[/ws] audio send error: {exc!r}")
                continue

            if "text" not in event or event["text"] is None:
                continue
            try:
                msg = json.loads(event["text"])
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "user_message":
                try:
                    await _handle_turn(ws, thread_id, msg.get("text", ""))
                except Exception as exc:  # noqa: BLE001 - surface a friendly error
                    print(f"[/ws] reply error: {exc!r}")
                    await ws.send_json(
                        {
                            "type": "error",
                            "message": "Oops, my alien brain glitched. Please try again.",
                        }
                    )

            elif msg_type == "greeting":
                await _speak_greeting(ws)

            elif msg_type == "start_recording":
                # Bonus A: open a Transcribe stream for this turn.
                try:
                    mic = MicSession(ws)
                    await mic.start()
                except Exception as exc:  # noqa: BLE001
                    mic = None
                    print(f"[/ws] mic start error: {exc!r}")
                    await ws.send_json(
                        {"type": "error", "message": "Could not start listening."}
                    )

            elif msg_type == "stop_recording":
                # Close the stream, take the final transcript, answer it.
                if mic is not None:
                    try:
                        final_text = await mic.stop()
                    except Exception as exc:  # noqa: BLE001
                        print(f"[/ws] mic stop error: {exc!r}")
                        final_text = ""
                    finally:
                        mic = None
                    if final_text.strip():
                        try:
                            await _handle_turn(ws, thread_id, final_text)
                        except Exception as exc:  # noqa: BLE001
                            print(f"[/ws] reply error: {exc!r}")
                            await ws.send_json(
                                {
                                    "type": "error",
                                    "message": "Oops, my alien brain glitched. Please try again.",
                                }
                            )
                    else:
                        # Empty transcript (often a muted mic).
                        await ws.send_json(
                            {"type": "transcript", "text": "", "partial": False}
                        )
    except WebSocketDisconnect:
        pass
    finally:
        if mic is not None:
            try:
                await mic.stop()
            except Exception:  # noqa: BLE001
                pass


# Serve the static assets (avatars, animations, music) and JS modules.
# Mounted last so the explicit routes above take precedence.
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")
