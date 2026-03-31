import asyncio
import argparse


def main() -> None:
    from wristturn.adapters.daemon import main as daemon_main

    parser = argparse.ArgumentParser(description="WristTurn macOS daemon")
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()
    try:
        asyncio.run(daemon_main(args.port))
    except KeyboardInterrupt:
        pass
