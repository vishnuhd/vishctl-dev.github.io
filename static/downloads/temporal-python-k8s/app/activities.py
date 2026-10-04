import asyncio

from temporalio import activity


@activity.defn
async def charge_card(order_id: str) -> str:
    activity.logger.info("Charging card for %s", order_id)
    return f"charged:{order_id}"


@activity.defn
async def reserve_stock(order_id: str) -> str:
    activity.logger.info("Reserving stock for %s", order_id)
    return f"reserved:{order_id}"


@activity.defn
async def pack_items(order_id: str) -> str:
    # Slow on purpose: 10 steps, 2s each. Heartbeats record progress, so if the
    # worker dies, the retry resumes from the last completed step.
    done = activity.info().heartbeat_details
    start = done[0] + 1 if done else 1
    for step in range(start, 11):
        activity.logger.info("Packing %s: step %d/10", order_id, step)
        await asyncio.sleep(2)
        activity.heartbeat(step)
    return f"packed:{order_id}(resumed at step {start})"


@activity.defn
async def send_email(order_id: str) -> str:
    # Flaky on purpose: fails on the first two attempts so Temporal retries it.
    attempt = activity.info().attempt
    if attempt < 3:
        raise RuntimeError(f"email service unavailable (attempt {attempt})")
    return f"emailed:{order_id}"


@activity.defn
async def refund_card(order_id: str) -> str:
    activity.logger.info("Refunding card for %s", order_id)
    return f"refunded:{order_id}"
