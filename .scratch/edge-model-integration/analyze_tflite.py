from __future__ import annotations

import argparse
import collections
import math
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter


@dataclass(frozen=True)
class ModelSource:
    name: str
    path: Path
    member: str | None = None

    def read(self) -> bytes:
        if self.member is None:
            return self.path.read_bytes()
        with zipfile.ZipFile(self.path) as archive:
            return archive.read(self.member)


def _shape_product(shape: np.ndarray) -> int:
    if shape.size == 0:
        return 0
    return math.prod(int(value) for value in shape)


def _tensor_map(interpreter: Interpreter) -> dict[int, dict[str, object]]:
    return {int(item["index"]): item for item in interpreter.get_tensor_details()}


def _tensor_shape(tensors: dict[int, dict[str, object]], index: int) -> np.ndarray:
    detail = tensors.get(index)
    if detail is None:
        return np.asarray([], dtype=np.int64)
    return np.asarray(detail["shape"], dtype=np.int64)


def estimate_macs(interpreter: Interpreter) -> tuple[int, collections.Counter[str], collections.Counter[str]]:
    tensors = _tensor_map(interpreter)
    ops = interpreter._get_ops_details()  # noqa: SLF001 - no public op-detail API exists
    counts: collections.Counter[str] = collections.Counter()
    macs_by_op: collections.Counter[str] = collections.Counter()

    for op in ops:
        op_name = str(op["op_name"])
        counts[op_name] += 1
        inputs = [int(index) for index in op["inputs"] if int(index) >= 0]
        outputs = [int(index) for index in op["outputs"] if int(index) >= 0]
        if not outputs:
            continue
        output_shape = _tensor_shape(tensors, outputs[0])

        if op_name == "CONV_2D" and len(inputs) >= 2 and output_shape.size == 4:
            filter_shape = _tensor_shape(tensors, inputs[1])
            if filter_shape.size == 4:
                batches, out_h, out_w, out_channels = (int(value) for value in output_shape)
                _, kernel_h, kernel_w, in_channels = (int(value) for value in filter_shape)
                macs_by_op[op_name] += (
                    batches * out_h * out_w * out_channels * kernel_h * kernel_w * in_channels
                )
        elif op_name == "DEPTHWISE_CONV_2D" and len(inputs) >= 2 and output_shape.size == 4:
            filter_shape = _tensor_shape(tensors, inputs[1])
            if filter_shape.size == 4:
                batches, out_h, out_w, out_channels = (int(value) for value in output_shape)
                _, kernel_h, kernel_w, _ = (int(value) for value in filter_shape)
                macs_by_op[op_name] += batches * out_h * out_w * out_channels * kernel_h * kernel_w
        elif op_name == "FULLY_CONNECTED" and len(inputs) >= 2:
            input_shape = _tensor_shape(tensors, inputs[0])
            weight_shape = _tensor_shape(tensors, inputs[1])
            if input_shape.size and weight_shape.size == 2:
                macs_by_op[op_name] += _shape_product(output_shape) * int(weight_shape[-1])
        elif op_name == "BATCH_MATMUL" and len(inputs) >= 2:
            left = _tensor_shape(tensors, inputs[0])
            right = _tensor_shape(tensors, inputs[1])
            if left.size >= 2 and right.size >= 2:
                batch = _shape_product(output_shape[:-2]) or 1
                macs_by_op[op_name] += (
                    batch * int(output_shape[-2]) * int(output_shape[-1]) * int(left[-1])
                )

    return sum(macs_by_op.values()), counts, macs_by_op


def synthetic_input(detail: dict[str, object]) -> np.ndarray:
    shape = tuple(int(value) for value in np.asarray(detail["shape"]))
    dtype = detail["dtype"]
    if np.issubdtype(dtype, np.integer):
        info = np.iinfo(dtype)
        return np.full(shape, (info.min + info.max) // 2, dtype=dtype)
    return np.zeros(shape, dtype=dtype)


def benchmark(interpreter: Interpreter, *, warmup: int, runs: int) -> tuple[float, float, float]:
    for detail in interpreter.get_input_details():
        interpreter.set_tensor(int(detail["index"]), synthetic_input(detail))
    for _ in range(warmup):
        interpreter.invoke()
    samples = []
    for _ in range(runs):
        started = time.perf_counter_ns()
        interpreter.invoke()
        samples.append((time.perf_counter_ns() - started) / 1_000_000.0)
    values = np.asarray(samples, dtype=np.float64)
    return float(values.mean()), float(np.percentile(values, 50)), float(np.percentile(values, 95))


def describe(source: ModelSource, *, threads: int, warmup: int, runs: int) -> None:
    content = source.read()
    interpreter = Interpreter(model_content=content, num_threads=threads)
    interpreter.allocate_tensors()
    macs, op_counts, macs_by_op = estimate_macs(interpreter)
    mean_ms, p50_ms, p95_ms = benchmark(interpreter, warmup=warmup, runs=runs)

    print(f"MODEL {source.name}")
    print(f"  bytes={len(content)}")
    print(f"  inputs={[(item['name'], item['shape'].tolist(), np.dtype(item['dtype']).name) for item in interpreter.get_input_details()]}")
    print(f"  outputs={[(item['name'], item['shape'].tolist(), np.dtype(item['dtype']).name) for item in interpreter.get_output_details()]}")
    print(f"  op_counts={dict(sorted(op_counts.items()))}")
    print(f"  estimated_macs={macs}")
    print(f"  estimated_ops_mul_add={macs * 2}")
    print(f"  macs_by_op={dict(macs_by_op)}")
    print(f"  cpu_{threads}t_mean_ms={mean_ms:.3f}")
    print(f"  cpu_{threads}t_p50_ms={p50_ms:.3f}")
    print(f"  cpu_{threads}t_p95_ms={p95_ms:.3f}")
    if macs:
        for utilization in (0.1, 0.2, 0.5, 1.0):
            effective_ops = 1_000_000_000_000 * utilization
            theoretical_ms = macs * 2 / effective_ops * 1000.0
            theoretical_fps = 1000.0 / theoretical_ms
            print(
                f"  at_1tops_{int(utilization * 100)}pct_ms={theoretical_ms:.3f} "
                f"max_fps={theoretical_fps:.1f}"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument("--runs", type=int, default=100)
    args = parser.parse_args()

    sources = (
        ModelSource(
            "movenet_lightning_f16",
            Path("models/runtime/movenet/movenet_lightning_f16_v4.tflite"),
        ),
        ModelSource(
            "mediapipe_pose_detector",
            Path("frontend/public/mediapipe/pose_landmarker_lite.task"),
            "pose_detector.tflite",
        ),
        ModelSource(
            "mediapipe_pose_landmarks_detector",
            Path("frontend/public/mediapipe/pose_landmarker_lite.task"),
            "pose_landmarks_detector.tflite",
        ),
    )
    for source in sources:
        describe(
            source,
            threads=args.threads,
            warmup=args.warmup,
            runs=args.runs,
        )


if __name__ == "__main__":
    main()
