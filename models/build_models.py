"""Build the test-area models in Maya and export them for the web page.

Run with Maya's Python (no need to open Maya):

    "C:/Program Files/Autodesk/Maya2027/bin/mayapy.exe" models/build_models.py

Writes, next to this file:
    test_area.ma   whole scene (floor, LED frame, 9 LEDs, robot, camera, light)
    robot.obj      robot only, at the origin, photodiode 1 facing +X
    led.obj        one LED fixture, emitter at the origin
    frame.obj      the frame that holds the LEDs, in place
    models.js      the three OBJ files as JS strings, so the page can use
                   them when opened straight from disk (file://)

Units are cm and +Z is up, the same as the web page's 3D view. z = 0 is
the floor. Change the numbers below and run again when the real sizes
are known.
"""
import json
import math
import os

import maya.standalone

maya.standalone.initialize(name='python')
import maya.cmds as cmds  # noqa: E402  (needs maya.standalone first)

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- measured / from the firmware ------------------------------------------
PD_HEIGHT = 1.0       # photodiode centres above the floor (cm), measured
LED_ABOVE_PD = 92.0   # LEDs above the photodiodes (cm), firmware p(k, 2) = 0.920 m
LED_Z = PD_HEIGHT + LED_ABOVE_PD
LED_SPACING = 50.0    # cm between neighbouring LEDs
# LED numbers in the 3x3 grid, top row (y = +50) first, from -X to +X
LED_GRID = [[8, 7, 6], [5, 4, 3], [2, 1, 0]]
FACE_TILT = 30.0      # side faces from horizontal; firmware be = 60 deg is the
                      # photodiode direction above horizontal, so 90 - 60

# ---- robot (derived) --------------------------------------------------------
# A photodiode sits at the centroid of its face, which is at 1/3 of the
# pyramid height, so h = 3 * PD_HEIGHT. The inradius of the base then
# follows from the face tilt: r = h / tan(tilt).
ROBOT_H = 3.0 * PD_HEIGHT
ROBOT_INR = ROBOT_H / math.tan(math.radians(FACE_TILT))   # base inradius
ROBOT_CIRC = 2.0 * ROBOT_INR                              # base circumradius
ROBOT_SIDE = 2.0 * math.sqrt(3.0) * ROBOT_INR             # base side (~18 cm)
PD_RADIUS = 0.6
PD_DEPTH = 0.3

# ---- LED fixture and frame (approximate) -------------------------------------
LED_LENS_R = 1.0      # dome under the housing
LED_HOUSING_R = 2.2
LED_HOUSING_H = 1.8
BAR = 2.0             # frame profile, 2 x 2 cm
FRAME_HALF = 70.0     # legs at x, y = +-70 cm
BAR_Z = LED_Z + LED_HOUSING_H + BAR / 2.0   # centre line of the top bars


def material(name, rgb):
    """Lambert shader + shading group. OBJ export names the material after the SG."""
    sg = name
    if cmds.objExists(sg):
        return sg
    sh = cmds.shadingNode('lambert', asShader=True, name=name + '_mat')
    cmds.setAttr(sh + '.color', rgb[0], rgb[1], rgb[2], type='double3')
    cmds.sets(renderable=True, noSurfaceShader=True, empty=True, name=sg)
    cmds.connectAttr(sh + '.outColor', sg + '.surfaceShader', force=True)
    return sg


def assign(objs, sg):
    cmds.sets(objs, edit=True, forceElement=sg)


def build_robot():
    """Pyramid on the floor, photodiode 1's face looking along +X."""
    body_sg = material('ra_body', (0.12, 0.12, 0.12))
    pd_sg = material('ra_pd', (0.75, 0.75, 0.75))
    pd1_sg = material('ra_pd1', (0.07, 0.54, 0.37))
    # base corners at 60, 180, 300 deg: the edge between 300 and 60 faces +X
    base = [(ROBOT_CIRC * math.cos(math.radians(a)), ROBOT_CIRC * math.sin(math.radians(a)), 0.0)
            for a in (60.0, 180.0, 300.0)]
    apex = (0.0, 0.0, ROBOT_H)
    faces = []
    for i in range(3):
        faces.append(cmds.polyCreateFacet(p=[base[i], base[(i + 1) % 3], apex])[0])
    faces.append(cmds.polyCreateFacet(p=[base[0], base[2], base[1]])[0])
    body = cmds.polyUnite(faces, constructionHistory=False, name='robot_body')[0]
    cmds.polyMergeVertex(body, distance=0.001, constructionHistory=False)
    cmds.polySoftEdge(body, angle=0, constructionHistory=False)  # hard edges
    assign(body, body_sg)

    # Firmware: v_l = (cos be cos al, -cos be sin al, sin be), al = 0, 120, -120 deg.
    # Face l's normal therefore points at azimuth -al.
    pds = []
    for l, al in enumerate((0.0, 120.0, -120.0)):
        az = math.radians(-al)
        el = math.radians(90.0 - FACE_TILT)
        n = (math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))
        # face centroid: 1/3 of the way up, above the base edge midpoint
        c = ((ROBOT_INR * 2.0 / 3.0) * math.cos(az), (ROBOT_INR * 2.0 / 3.0) * math.sin(az), ROBOT_H / 3.0)
        pd = cmds.polyCylinder(radius=PD_RADIUS, height=PD_DEPTH, axis=n, subdivisionsAxis=16,
                               constructionHistory=False, name='photodiode%d' % (l + 1))[0]
        cmds.move(c[0] + n[0] * PD_DEPTH / 2.0, c[1] + n[1] * PD_DEPTH / 2.0, c[2] + n[2] * PD_DEPTH / 2.0, pd)
        cmds.makeIdentity(pd, apply=True, translate=True)
        assign(pd, pd1_sg if l == 0 else pd_sg)
        pds.append(pd)
    return cmds.group([body] + pds, name='robot')


def build_led(name):
    """One LED fixture: housing above, lens dome below, emitter at the origin."""
    housing_sg = material('ra_led_housing', (0.35, 0.35, 0.35))
    lens_sg = material('ra_led_lens', (0.79, 0.52, 0.0))
    housing = cmds.polyCylinder(radius=LED_HOUSING_R, height=LED_HOUSING_H, axis=(0, 0, 1),
                                subdivisionsAxis=24, constructionHistory=False, name=name + '_housing')[0]
    cmds.move(0, 0, LED_HOUSING_H / 2.0, housing)
    lens = cmds.polySphere(radius=LED_LENS_R, subdivisionsAxis=20, subdivisionsHeight=12,
                           axis=(0, 0, 1), constructionHistory=False, name=name + '_lens')[0]
    # keep the lower half: delete faces whose centre is above z = 0
    upper = [f for f in cmds.ls(lens + '.f[*]', flatten=True)
             if sum(cmds.xform(cmds.polyListComponentConversion(f, toVertex=True), q=True,
                               worldSpace=True, translation=True)[2::3]) > 0]
    if upper:
        cmds.delete(upper)
    assign(housing, housing_sg)
    assign(lens, lens_sg)
    for o in (housing, lens):
        cmds.makeIdentity(o, apply=True, translate=True)
    return cmds.group([housing, lens], name=name)


def bar(name, p0, p1):
    """Square profile from p0 to p1 along one axis."""
    size = [BAR, BAR, BAR]
    axis = [i for i in range(3) if abs(p1[i] - p0[i]) > 1e-6][0]
    size[axis] = abs(p1[axis] - p0[axis])
    b = cmds.polyCube(width=size[0], height=size[1], depth=size[2], constructionHistory=False, name=name)[0]
    cmds.move((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0, (p0[2] + p1[2]) / 2.0, b)
    cmds.makeIdentity(b, apply=True, translate=True)
    return b


def build_frame():
    sg = material('ra_frame', (0.6, 0.62, 0.65))
    F, top = FRAME_HALF, BAR_Z + BAR / 2.0
    parts = []
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        parts.append(bar('leg%d' % i, (sx * F, sy * F, 0.0), (sx * F, sy * F, top)))
    # outer ring and the three bars the LED rows hang from (y = -50, 0, +50)
    for y in (-F, -LED_SPACING, 0.0, LED_SPACING, F):
        parts.append(bar('barX_%d' % int(y), (-F, y, BAR_Z), (F, y, BAR_Z)))
    for x in (-F, F):
        parts.append(bar('barY_%d' % int(x), (x, -F, BAR_Z), (x, F, BAR_Z)))
    assign(parts, sg)
    return cmds.group(parts, name='frame')


def export_obj(node, path):
    cmds.select(node, replace=True)
    cmds.file(path, force=True, exportSelected=True, type='OBJexport', preserveReferences=False,
              options='groups=1;ptgroups=1;materials=1;smoothing=1;normals=1')
    mtl = os.path.splitext(path)[0] + '.mtl'
    if os.path.exists(mtl):
        os.remove(mtl)  # the page sets its own colours by material name


def main():
    cmds.file(new=True, force=True)
    cmds.loadPlugin('objExport', quiet=True)
    cmds.currentUnit(linear='cm')
    cmds.upAxis(axis='z', rotateView=True)

    robot = build_robot()
    led = build_led('led_proto')
    frame = build_frame()

    export_obj(robot, os.path.join(HERE, 'robot.obj'))
    export_obj(led, os.path.join(HERE, 'led.obj'))
    export_obj(frame, os.path.join(HERE, 'frame.obj'))

    # whole scene for Maya: floor, frame, 9 LEDs in place, robot at the origin
    floor_sg = material('ra_floor', (0.85, 0.85, 0.82))
    floor = cmds.polyPlane(width=150, height=150, axis=(0, 0, 1), subdivisionsX=1, subdivisionsY=1,
                           constructionHistory=False, name='floor')[0]
    cmds.move(0, 0, -0.01, floor)
    cmds.sets(floor, edit=True, forceElement=floor_sg)
    leds = []
    for row, nums in enumerate(LED_GRID):
        for col, num in enumerate(nums):
            inst = cmds.instance(led, name='LED_%d' % num)[0]
            cmds.move((col - 1) * LED_SPACING, (1 - row) * LED_SPACING, LED_Z, inst)
            leds.append(inst)
    cmds.hide(led)  # the prototype stays at the origin, hidden
    cmds.group(leds, name='leds')
    cam, cam_shape = cmds.camera(name='viewCam')
    cmds.move(110, -240, 175, cam)
    cmds.viewPlace(cam_shape, lookAt=(0, 0, 35))
    sun = cmds.directionalLight(name='sun', intensity=1.0)
    cmds.xform(cmds.listRelatives(sun, parent=True)[0], rotation=(40, 0, -30))
    cmds.file(rename=os.path.join(HERE, 'test_area.ma'))
    cmds.file(save=True, type='mayaAscii', force=True)

    # embed the OBJ text for the page
    data = {}
    for key in ('robot', 'led', 'frame'):
        with open(os.path.join(HERE, key + '.obj')) as fh:
            data[key] = fh.read()
    meta = {'pdHeight': PD_HEIGHT, 'ledAbovePd': LED_ABOVE_PD, 'ledZ': LED_Z,
            'robotHeight': round(ROBOT_H, 3), 'robotSide': round(ROBOT_SIDE, 3),
            'robotInradius': round(ROBOT_INR, 3), 'ledHousingH': LED_HOUSING_H}
    with open(os.path.join(HERE, 'models.js'), 'w', newline='\n') as fh:
        fh.write('// Generated by models/build_models.py (Maya) - do not edit by hand.\n')
        fh.write('// OBJ text of the 3D view models, in cm, +Z up, z = 0 = floor.\n')
        fh.write('window.RA_MODELS = ' + json.dumps({'meta': meta, 'obj': data}, indent=1) + ';\n')
    print('robot: side %.2f cm, height %.2f cm; LEDs at z = %.1f cm' % (ROBOT_SIDE, ROBOT_H, LED_Z))


main()
maya.standalone.uninitialize()
