# Homepage modular cube

## Original local geometry

- Model: `frontend/src/lib/modular-cube.ts`.
- Still preview: `frontend/src/components/scene/CubePoster.tsx`.
- Renderer: `frontend/src/components/scene/ClonerCubeRuntime.tsx`.
- Loading, visibility and controls: `frontend/src/components/scene/ClonerCube.tsx`.

The project owner approved replacing the previous Spline embed with an independently authored, watermark-free white-and-teal cube. The new model contains 406 deterministic cuboids: porcelain panels and terraces, teal inserts, and a recessed dark core. It uses no Spline export data, downloaded model, remote image or texture. The previous Spline asset was replaced, not modified to conceal its branding. No paid account changes were made.

## Rendering and interaction

Three.js is already used by the market depth visualization. The cube reuses that lazy-loaded dependency, with one shared bevelled box geometry, three instanced material groups, directional lighting, and a pixel ratio capped at1.5. The orthographic camera preserves its framing across resizes. There is no additional model or texture network request.

Slow rotation is optional. Drag or arrow keys rotate the sculpture and pause automatic motion; Home or Reset restores its original view. Pause keeps the current angle. Offscreen/hidden rendering stops; resizing a paused scene draws a single refreshed frame. Cleanup disposes geometries, materials, shadows and renderer resources.

Mobile and reduced-motion preferences start with the local SVG still. Activate3D is explicit opt-in. The still uses the same geometry and camera projection as the live view. A failed chunk load or WebGL context shows that preview with Retry3D; neither failure blocks the website.

The visual is decorative. All prices, order quantities and auction results continue to come from the connected contracts in separate HTML and chart components.

## Maintenance

Edit the shared geometry model to change both the sculpture and its still. Keep model bounds within the tested camera envelope. Run frontend tests, lint and production build, then visually verify live/still views, controls, desktop/mobile framing and paused resizing.

The Spline runtime packages and legacy optional Spline branch have been removed. The earlier Spline export and its required branding are no longer part of the frontend.
