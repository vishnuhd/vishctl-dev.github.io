import asyncio
import os
import sys

from temporalio.client import Client


async def main() -> None:
    wf_id, action = sys.argv[1], sys.argv[2]  # action: approve | cancel
    client = await Client.connect(os.getenv("TEMPORAL_ADDRESS", "localhost:7233"))
    handle = client.get_workflow_handle(wf_id)
    await handle.signal(action)
    print(await handle.result())


if __name__ == "__main__":
    asyncio.run(main())
