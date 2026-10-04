import asyncio
import os
import sys

from temporalio.client import Client

from app.worker import TASK_QUEUE
from app.workflows import OrderWorkflow


async def main() -> None:
    order_id = sys.argv[1] if len(sys.argv) > 1 else "order-1001"
    client = await Client.connect(os.getenv("TEMPORAL_ADDRESS", "localhost:7233"))
    handle = await client.start_workflow(
        OrderWorkflow.run, order_id, id=f"order-{order_id}", task_queue=TASK_QUEUE
    )
    print(f"Started workflow {handle.id} (run {handle.result_run_id})")


if __name__ == "__main__":
    asyncio.run(main())
