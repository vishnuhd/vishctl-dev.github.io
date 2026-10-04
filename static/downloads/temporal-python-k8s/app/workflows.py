from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.activities import charge_card, pack_items, refund_card, reserve_stock, send_email


@workflow.defn
class OrderWorkflow:
    def __init__(self) -> None:
        self.approved: bool | None = None
        self.status = "created"

    @workflow.signal
    def approve(self) -> None:
        self.approved = True

    @workflow.signal
    def cancel(self) -> None:
        self.approved = False

    @workflow.query
    def get_status(self) -> str:
        return self.status

    @workflow.run
    async def run(self, order_id: str) -> str:
        opts = {
            "start_to_close_timeout": timedelta(seconds=10),
            "retry_policy": RetryPolicy(initial_interval=timedelta(seconds=2)),
        }
        self.status = "charging"
        await workflow.execute_activity(charge_card, order_id, **opts)
        self.status = "reserving"
        await workflow.execute_activity(reserve_stock, order_id, **opts)

        self.status = "packing"
        await workflow.execute_activity(
            pack_items,
            order_id,
            start_to_close_timeout=timedelta(minutes=2),
            heartbeat_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=1)),
        )

        self.status = "waiting for approval"
        await workflow.wait_condition(lambda: self.approved is not None)
        if not self.approved:
            self.status = "cancelled"
            await workflow.execute_activity(refund_card, order_id, **opts)
            return f"{order_id}: cancelled and refunded"

        self.status = "emailing"
        await workflow.execute_activity(send_email, order_id, **opts)
        self.status = "completed"
        return f"{order_id}: completed"
