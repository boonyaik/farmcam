# Farmcam Web — Image Measurement

A lightweight, client-side web app to measure real-world distances in images.
It detects an ArUco marker of known size, computes a homography, rectifies the image into a top-down metric plane (pixels-per-centimeter), and lets you create, nudge, delete, and export annotated measurements.

## Features

- ArUco-based metric calibration
- Auto-computes px/cm from a detected marker of known physical size.
- Falls back to manual px/cm when auto is disabled.
- Planar rectification
- Warps the image so measurements are in real-world centimeters (if a marker is detected).
- Otherwise, measures in pixels.


## Efficient interaction

- Zoom (wheel / + / - / 0), pan (middle-drag or Space+Left-drag).
- Pairwise measurements by clicking two points.
- Label nudge via arrow keys after selecting a label.
- Delete a selected measurement (button or Delete/Backspace).
- Clean export
- Saves an annotated image as <original_name>_annotated.jpg (JPEG).
- Runs entirely in the browser. No uploads, no servers required.

## Credits

Detection: js-aruco2
Geometry/warp: OpenCV.js
