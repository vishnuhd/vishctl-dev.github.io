import asyncio
import os

from temporalio.client import Client
from temporalio.worker import Worker

from app.activities import charge_card, pack_items, refund_card, reserve_stock, send_email
from app.workflows import OrderWorkflow

TASK_QUEUE = "orders"


async def main() -> None:
    client = await Client.connect(os.getenv("TEMPORAL_ADDRESS", "localhost:7233"))
    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[OrderWorkflow],
        activities=[charge_card, reserve_stock, pack_items, send_email, refund_card],
    )
    print("Worker started on queue", TASK_QUEUE, flush=True)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
