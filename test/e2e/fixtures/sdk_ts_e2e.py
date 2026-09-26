"""Fixture tasks for the flyte-sdk-ts end-to-end tests.

Deliberately tiny and dependency-free so the TypeScript SDK's remote-execution
surface (typed inputs, defaults, outputs, child actions, conditions) can be
exercised quickly and deterministically.
"""

import flyte

env = flyte.TaskEnvironment(name="sdk_ts_e2e")


@env.task
async def add(x: int, y: int = 10) -> int:
    """Typed scalars with a registered default on `y`."""
    return x + y


@env.task
async def echo_types(
    name: str, count: int, ratio: float, flag: bool, tags: list[str]
) -> dict[str, str]:
    """Round-trips every simple scalar type plus a collection."""
    return {
        "name": name,
        "count": str(count),
        "ratio": str(ratio),
        "flag": str(flag),
        "tags": ",".join(tags),
    }


@env.task
async def parent(n: int) -> int:
    """Fans out to child actions so action listing has something to show."""
    total = 0
    for i in range(n):
        total += await add(x=i, y=1)
    return total


@env.task
async def always_fails(message: str) -> str:
    """Fails on purpose so failure reporting can be verified."""
    raise ValueError(message)


@env.task
async def needs_approval(amount: int) -> str:
    """Pauses on a condition until an external signal arrives."""
    condition = flyte.new_condition(
        "approve",
        data_type=bool,
        prompt=f"Approve spending {amount}?",
        description="Approve or reject the spend",
    )
    approved = condition.wait()
    return f"approved={approved} amount={amount}"


if __name__ == "__main__":
    flyte.init_from_config()
    print(flyte.deploy(env))
