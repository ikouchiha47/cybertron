/**
 * WristTurn — shared Three.js helpers for design iteration files.
 * Include this AFTER the three@0.128.0 classic script tags.
 *
 * Exports (globals):
 *   WT.setupScene(bgColor)  → { renderer, labelRenderer, scene, camera, controls }
 *   WT.stdMat(hex, rough, metal)
 *   WT.box(w, h, d, mat)
 *   WT.addEdges(mesh, col)
 *   WT.makeLabel(html, borderColor)
 *   WT.buildStack(scene)    → yTop  (top of stack, excl. strap)
 *
 * Stack dimensions (v2 — LSM6DS3, no external BNO085):
 *   Watch strap:            52 × 24 × 2.5 mm
 *   XIAO nRF52840 Sense:   21 × 17.5 × 3.5 mm  (IMU onboard)
 *   Foam spacer:           21 × 18 × 5 mm
 *   LiPo 150 mAh:          30 × 25 × 3 mm
 *   ─────────────────────────────────────────
 *   Total stack (no strap): 11.5 mm
 */

var WT = (function () {

  // ── scene setup ─────────────────────────────────────────────────────────────
  function setupScene(bgColor) {
    bgColor = bgColor || 0x0e1117;

    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    var labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.cssText = 'position:absolute;top:0;pointer-events:none';
    document.body.appendChild(labelRenderer.domElement);

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(bgColor);
    scene.fog = new THREE.Fog(bgColor, 180, 320);

    var camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 500);
    camera.position.set(70, 55, 90);

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.target.set(0, 12, 0);
    controls.minDistance = 30;
    controls.maxDistance = 250;
    controls.zoomSpeed = 0.35;   // default 1.0 — reduce so scroll isn't jumpy

    // lighting — schematic mode (flat, readable)
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(60, 90, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -60;
    sun.shadow.camera.right = sun.shadow.camera.top = 60;
    scene.add(sun);
    var fill = new THREE.DirectionalLight(0x6688cc, 0.35);
    fill.position.set(-40, 30, -40);
    scene.add(fill);

    // lighting — rendered mode (warmer, sharper shadows, rim light)
    var sunR = new THREE.DirectionalLight(0xfff4e0, 1.6);
    sunR.position.set(50, 100, 40);
    sunR.castShadow = true;
    sunR.shadow.mapSize.set(4096, 4096);
    sunR.shadow.camera.left = sunR.shadow.camera.bottom = -60;
    sunR.shadow.camera.right = sunR.shadow.camera.top = 60;
    sunR.shadow.bias = -0.001;
    sunR.visible = false;
    scene.add(sunR);

    var hemi = new THREE.HemisphereLight(0xddeeff, 0x222222, 0.7);
    hemi.visible = false;
    scene.add(hemi);

    var rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-60, 20, -60);
    rim.visible = false;
    scene.add(rim);

    // ground plane (rendered mode only)
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.6;
    ground.receiveShadow = true;
    ground.visible = false;
    scene.add(ground);

    var renderMode = false;

    function setRenderMode(on) {
      renderMode = on;
      // schematic lights
      sun.visible  = !on;
      fill.visible = !on;
      // rendered lights
      sunR.visible  = on;
      hemi.visible  = on;
      rim.visible   = on;
      ground.visible = on;
      // tone mapping
      renderer.toneMapping         = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      renderer.toneMappingExposure = on ? 1.2 : 1.0;
      // fog
      scene.fog = on
        ? new THREE.Fog(0x0e1117, 220, 400)
        : new THREE.Fog(0x0e1117, 180, 320);
    }

    // grid
    var grid = new THREE.GridHelper(140, 28, 0x1e293b, 0x1e293b);
    grid.position.y = -0.5;
    scene.add(grid);

    // resize
    window.addEventListener('resize', function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      labelRenderer.setSize(window.innerWidth, window.innerHeight);
    });

    // animate
    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    })();

    return { renderer: renderer, labelRenderer: labelRenderer, scene: scene, camera: camera, controls: controls, setRenderMode: setRenderMode };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  function stdMat(hex, rough, metal) {
    return new THREE.MeshStandardMaterial({ color: hex, roughness: rough !== undefined ? rough : 0.45, metalness: metal !== undefined ? metal : 0.05 });
  }

  function box(w, h, d, mat) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  function addEdges(mesh, col) {
    var eg = new THREE.EdgesGeometry(mesh.geometry);
    var lm = new THREE.LineBasicMaterial({ color: col || 0x1f2937, transparent: true, opacity: 0.65 });
    mesh.add(new THREE.LineSegments(eg, lm));
  }

  function makeLabel(html, borderColor) {
    var div = document.createElement('div');
    div.className = 'layer-label';
    div.style.borderLeft = '2px solid ' + (borderColor || '#4b5563');
    div.innerHTML = html;
    return new THREE.CSS2DObject(div);
  }

  // ── component stack (v2: XIAO Sense only, no BNO085 board) ──────────────────
  // Returns yTop — the Y coordinate of the top surface of the stack.
  function buildStack(scene, opts) {
    opts = opts || {};
    var showLabels = opts.showLabels !== false;

    // wrist
    var wristGeo = new THREE.CylinderGeometry(18, 18, 55, 48, 1, false, 0, Math.PI);
    var wrist = new THREE.Mesh(wristGeo, new THREE.MeshStandardMaterial({ color: 0xc8956c, roughness: 0.9, side: THREE.BackSide }));
    wrist.rotation.z = Math.PI / 2;
    wrist.position.set(0, -18, 0);
    scene.add(wrist);

    // strap
    var strap = box(52, 2.5, 24, stdMat(0x1c1c1c, 0.95, 0));
    strap.position.y = 1.25;
    addEdges(strap, 0x374151);
    scene.add(strap);
    if (showLabels) {
      var sl = makeLabel('<strong style="color:#94a3b8">Watch strap</strong><br><span style="font-size:9px;color:#4b5563">52×24×2.5mm</span>', '#374151');
      sl.position.set(29, 0, 0);
      strap.add(sl);
    }

    var yBase = 2.5;

    // XIAO nRF52840 Sense (toward skin)
    var xiaoH = 3.5;
    var xiao = box(21, xiaoH, 17.5, stdMat(0x1e40af));
    xiao.position.y = yBase + xiaoH / 2;
    addEdges(xiao, 0x3b82f6);
    scene.add(xiao);
    // onboard IMU chip
    var imuChip = box(3, 1.2, 3, stdMat(0x0f172a, 0.2, 0.6));
    imuChip.position.set(-5, yBase + xiaoH + 0.6, 0);
    scene.add(imuChip);
    // antenna trace
    var ant = box(5, 0.4, 1, stdMat(0xfbbf24, 0.3, 0.8));
    ant.position.set(9, yBase + xiaoH, -4);
    scene.add(ant);
    // USB-C stub (at +Z end, centered)
    var usb = box(2.5, 1.5, 3, stdMat(0x60a5fa, 0.3, 0.7));
    usb.position.set(0, yBase + xiaoH / 2, 17.5 / 2 + 1);
    scene.add(usb);
    if (showLabels) {
      var xl = makeLabel('<strong style="color:#60a5fa">XIAO nRF52840 Sense</strong><br><span style="font-size:9px;color:#4b5563">21×17.5×3.5mm · LSM6DS3 onboard</span>', '#2563eb');
      xl.position.set(14, 0, 0);
      xiao.add(xl);
    }
    yBase += xiaoH;

    // Foam spacer
    var spH = 5;
    var spacer = box(21, spH, 18, new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95, transparent: true, opacity: 0.55 }));
    spacer.position.y = yBase + spH / 2;
    addEdges(spacer, 0x94a3b8);
    scene.add(spacer);
    if (showLabels) {
      var spl = makeLabel('<strong style="color:#94a3b8">Foam spacer</strong><br><span style="font-size:9px;color:#4b5563">21×18×5mm</span>', '#94a3b8');
      spl.position.set(14, 0, 0);
      spacer.add(spl);
    }
    yBase += spH;

    // LiPo (outermost)
    var lipoH = 3;
    var lipo = box(30, lipoH, 25, stdMat(0xc2410c, 0.6, 0.1));
    lipo.position.y = yBase + lipoH / 2;
    addEdges(lipo, 0xf97316);
    scene.add(lipo);
    var jst = box(2.5, 2, 5, stdMat(0xf97316, 0.5, 0.1));
    jst.position.set(16, yBase + lipoH / 2, 0);
    scene.add(jst);
    if (showLabels) {
      var ll = makeLabel('<strong style="color:#fb923c">LiPo 150mAh</strong><br><span style="font-size:9px;color:#4b5563">30×25×3mm · 3.7V JST PH2.0</span>', '#f97316');
      ll.position.set(18, 0, 0);
      lipo.add(ll);
    }
    yBase += lipoH;

    return yBase;  // top of stack
  }

  return {
    setupScene: setupScene,
    stdMat: stdMat,
    box: box,
    addEdges: addEdges,
    makeLabel: makeLabel,
    buildStack: buildStack
  };

})();
