"""
Export YOLOv8n to TFLite for use with react-native-fast-tflite on Android.

Two-step process (TensorFlow has no macOS ARM pip package, so we go via ONNX):
  1. PyTorch → ONNX  (ultralytics)
  2. ONNX → TFLite   (onnx2tf)

Output files land in ./tflite_output/:
  yolov8n_float32.tflite   — best accuracy, ~12MB
  yolov8n_float16.tflite   — good accuracy, ~6MB
  yolov8n_integer_quant.tflite — INT8, ~3MB (requires representative data for good results)

Copy the chosen model to assets/models/yolov8n.tflite in the app.

Output tensor layout (float32 model):
  Shape  : [1, 84, 2100]  — NOT transposed to channel-last (onnx2tf keeps it)
  Row 0  : cx  (pixels, 0-320)
  Row 1  : cy
  Row 2  : w
  Row 3  : h
  Row 4  : person score  (class 0, sigmoid applied, range 0-1)
  Row 5+ : other 79 COCO class scores

  Access in JS:
    personScore = raw[4 * 2100 + i]   for detection i in 0..2099
    boxHeight   = raw[3 * 2100 + i] / 320.0  (normalised)

Usage:
  uv run scripts/export_yolov8n.py
  # or
  python scripts/export_yolov8n.py --size 320 --out tflite_output
"""

import argparse
import subprocess
import sys
from pathlib import Path


def export_onnx(model_name: str, imgsz: int, out_dir: Path) -> Path:
    try:
        from ultralytics import YOLO
    except ImportError:
        print("ultralytics not found — install with: uv pip install ultralytics")
        sys.exit(1)

    onnx_path = out_dir / f"{model_name}.onnx"
    print(f"Exporting {model_name} → ONNX at {onnx_path} ...")
    model = YOLO(f"{model_name}.pt")
    result = model.export(format="onnx", imgsz=imgsz, opset=12)
    # ultralytics saves next to the .pt — move it
    src = Path(f"{model_name}.onnx")
    if src.exists() and src != onnx_path:
        src.rename(onnx_path)
    print(f"ONNX saved: {onnx_path}")
    return onnx_path


def export_tflite(onnx_path: Path, out_dir: Path) -> None:
    try:
        import onnx2tf  # noqa: F401
    except ImportError:
        print("onnx2tf not found — install with: uv pip install onnx2tf")
        sys.exit(1)

    print(f"Converting {onnx_path} → TFLite in {out_dir} ...")
    subprocess.run(
        [
            sys.executable, "-m", "onnx2tf",
            "-i", str(onnx_path),
            "-o", str(out_dir),
            "-oiqt",   # output int8, float16, float32 variants
        ],
        check=True,
    )
    print("TFLite models written to", out_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export YOLOv8n to TFLite")
    parser.add_argument("--model", default="yolov8n", help="YOLOv8 model variant (default: yolov8n)")
    parser.add_argument("--size",  default=320, type=int, help="Input image size (default: 320)")
    parser.add_argument("--out",   default="tflite_output", help="Output directory (default: tflite_output)")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    onnx_path = export_onnx(args.model, args.size, out_dir)
    export_tflite(onnx_path, out_dir)

    print("\nDone. Copy your chosen model:")
    print(f"  cp {out_dir}/yolov8n_float32.tflite assets/models/yolov8n.tflite")


if __name__ == "__main__":
    main()
