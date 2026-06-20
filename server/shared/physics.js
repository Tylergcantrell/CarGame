import * as CANNON from "cannon-es";

export function createPhysicsWorld() {
  const physics = new CANNON.World({
    gravity: new CANNON.Vec3(0, -24, 0),
  });
  physics.broadphase = new CANNON.SAPBroadphase(physics);
  physics.allowSleep = true;
  physics.solver.iterations = 6;
  physics.solver.tolerance = 0.008;
  physics.defaultContactMaterial.friction = 0.55;
  physics.defaultContactMaterial.restitution = 0.02;

  const groundMaterial = new CANNON.Material("ground");
  const obstacleMaterial = new CANNON.Material("obstacle");
  const chassisMaterial = new CANNON.Material("chassis");
  const roofMaterial = new CANNON.Material("slick-roof");

  physics.addContactMaterial(
    new CANNON.ContactMaterial(chassisMaterial, groundMaterial, {
      friction: 0.06,
      restitution: 0.015,
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 4,
    }),
  );
  physics.addContactMaterial(
    new CANNON.ContactMaterial(chassisMaterial, obstacleMaterial, {
      friction: 0.015,
      restitution: 0.01,
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 5,
    }),
  );
  physics.addContactMaterial(
    new CANNON.ContactMaterial(roofMaterial, groundMaterial, {
      friction: 0.05,
      restitution: 0.015,
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 4,
    }),
  );
  physics.addContactMaterial(
    new CANNON.ContactMaterial(roofMaterial, obstacleMaterial, {
      friction: 0.028,
      restitution: 0.01,
      contactEquationStiffness: 1e7,
      contactEquationRelaxation: 5,
    }),
  );

  return {
    physics,
    groundMaterial,
    obstacleMaterial,
    chassisMaterial,
    roofMaterial,
  };
}
