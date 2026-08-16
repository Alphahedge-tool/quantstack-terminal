"""
Nubra live-tick bridge.

Nubra's realtime feed is only reachable through their Python SDK
(`nubra_python_sdk.ticker.websocketdata`) — the wire protocol behind
wss://api.nubra.io/ws is not documented, so there is no honest way to speak it
from Node. This process is the adapter: it holds the SDK socket open and prints
one JSON object per line on stdout, which the Node side reads as NDJSON.

  stdin   unused
  stdout  {"event": ..., "received_at_ms": ..., "data": ...}  one per line
  stderr  free-text diagnostics, forwarded to the client as `log` events

Config arrives as a single base64-encoded JSON argv[1] — not env vars, not a
file: the session token is in there, and argv of a short-lived child is the
least-exposed of the three.

Ported from D:/Alphahedgetool/scripts/nubra_ws_bridge.py, which has been driving
the same subscriptions in production; keep the two in step.
"""

import base64
import json
import sys
import time
from dataclasses import asdict, is_dataclass

from nubra_python_sdk.ticker import websocketdata

try:
    import msgspec
except Exception:  # pragma: no cover - optional outside Nubra SDK installs
    msgspec = None


def emit(event, **payload):
    print(
        json.dumps(
            {"event": event, "received_at_ms": int(time.time() * 1000), **payload},
            default=to_json,
        ),
        flush=True,
    )


def to_json(value):
    if is_dataclass(value):
        return asdict(value)
    if msgspec is not None and isinstance(value, msgspec.Struct):
        return msgspec.to_builtins(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if hasattr(value, "__dict__"):
        return {k: v for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def read_config():
    if len(sys.argv) < 2:
        raise ValueError("Missing bridge config.")
    raw = base64.b64decode(sys.argv[1]).decode("utf-8")
    return json.loads(raw)


class TokenClient:
    """The shape the SDK expects of a logged-in client.

    We already hold a session from the Node side's TOTP login, so this stands in
    for the SDK's own auth flow rather than repeating it — no second login, no
    second device id.
    """

    def __init__(self, config):
        env = str(config.get("environment") or "").lower()
        if "uat" in env:
            self.API_BASE_URL = "https://uatapi.nubra.io"
            self.WEBSOCKET_URL = "wss://uatapi.nubra.io/ws"
            self.WEBSOCKET_URL_BATCH = "wss://uatapi.nubra.io/apibatch/ws"
        else:
            self.API_BASE_URL = "https://api.nubra.io"
            self.WEBSOCKET_URL = "wss://api.nubra.io/ws"
            self.WEBSOCKET_URL_BATCH = "wss://api.nubra.io/apibatch/ws"

        token = str(config.get("token") or "").replace("Bearer ", "").strip()
        device_id = str(config.get("deviceId") or "").strip()
        self.BEARER_TOKEN = token
        self.HEADERS = {
            "Authorization": f"Bearer {token}",
            "x-device-id": device_id,
            "Content-Type": "application/json",
            "x-device-os": "sdk",
        }
        self.token_data = {
            "session_token": token,
            "auth_token": token,
            "x-device-id": device_id,
        }
        self.db_path = "auth_data.db"
        self.totp_login = False
        self.env_path_login = False


def main():
    config = read_config()
    mode = str(config.get("mode") or "straddle").lower().strip()
    symbol = str(config.get("symbol") or "").upper().strip()
    spot_symbol = str(config.get("spotSymbol") or symbol).upper().strip()
    exchange = str(config.get("exchange") or "NSE").upper().strip()
    interval = str(config.get("interval") or "1m").strip()
    expiry = str(config.get("expiry") or "").strip()
    ref_ids = [str(r).strip() for r in config.get("refIds") or [] if str(r).strip()]
    index_symbols = [
        str(s).upper().strip()
        for s in config.get("indexSymbols") or []
        if str(s).strip()
    ]

    # `quotes` mode addresses contracts individually and has no single
    # underlying, so the straddle-shaped requirement does not apply to it.
    if mode != "quotes" and not symbol:
        raise ValueError("symbol is required")
    if not config.get("token"):
        raise ValueError("token is required")

    client = TokenClient(config)

    socket = websocketdata.NubraDataSocket(
        client=client,
        on_index_data=lambda m: emit("index", data=to_json(m)),
        on_ohlcv_data=lambda m: emit("ohlcv", data=to_json(m)),
        on_option_data=lambda m: emit("option", data=to_json(m)),
        on_orderbook_data=lambda m: emit("orderbook", data=to_json(m)),
        on_greeks_data=lambda m: emit("greeks", data=to_json(m)),
        on_connect=lambda m: emit("status", status="connected", message=to_json(m)),
        on_close=lambda r: emit("status", status="closed", message=to_json(r)),
        on_error=lambda e: emit("error", message=str(e)),
    )
    socket.connect()

    if mode == "quotes":
        # ── Per-contract mode ──
        #
        # Deliberately NOT the `option` chain stream. Three reasons, in order of
        # weight:
        #
        #   1. A chain key is ASSET:EXPIRY, so it cannot express "these 40
        #      contracts across two underlyings" — which is exactly what a
        #      generic subscribe(keys) has to say.
        #   2. `greeks` already carries iv, delta, gamma, theta, vega AND
        #      last_traded_price per contract, so one subscription per ref_id
        #      covers everything a surface needs.
        #   3. Session weight: greeks costs 1 per ref_id against a chain's 20
        #      per key, and only the contracts actually on screen are paid for.
        #
        # `index` (weight 1) carries the underlying, because an IV solved or
        # quoted against a stale spot is wrong in precisely the direction this
        # terminal measures.
        if ref_ids:
            socket.subscribe(ref_ids, data_type="greeks", exchange=exchange)
        for index_symbol in index_symbols:
            socket.subscribe([index_symbol], data_type="index", exchange=exchange)

        emit(
            "status",
            status="subscribed",
            mode=mode,
            exchange=exchange,
            ref_ids=len(ref_ids),
            index_symbols=len(index_symbols),
            # Weight spent, so an over-subscription is visible in the log rather
            # than surfacing later as a silently rejected subscribe.
            weight=len(ref_ids) + len(index_symbols),
        )
    else:
        # The chain feed carries every strike's LTP/IV and the underlying's
        # current_price, so it is the one subscription the straddle cannot run
        # without. Orderbook and greeks refine it (true bid/ask, broker IV) for
        # the band of strikes the engine actually prices.
        if spot_symbol:
            socket.subscribe([spot_symbol], data_type="ohlcv", interval=interval, exchange=exchange)
        if expiry:
            socket.subscribe([f"{symbol}:{expiry}"], data_type="option", exchange=exchange)
        if ref_ids:
            socket.subscribe(ref_ids, data_type="orderbook")
            socket.subscribe(ref_ids, data_type="greeks", exchange=exchange)

        emit(
            "status",
            status="subscribed",
            mode=mode,
            symbol=symbol,
            spot_symbol=spot_symbol,
            exchange=exchange,
            interval=interval,
            expiry=expiry,
            ref_ids=len(ref_ids),
        )

    try:
        if hasattr(socket, "keep_running"):
            socket.keep_running()
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        socket.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit("error", message=str(exc))
        raise
