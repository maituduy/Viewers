import { vec3 } from 'gl-matrix';
import { dicomSplit } from './dicomSplit';

/**
 * Combine the Per instance frame data, the shared frame data
 * and the root data objects.
 * The data is combined by taking nested sequence objects within
 * the functional group sequences.  Data that is directly contained
 * within the functional group sequences, such as private creators
 * will be ignored.
 * This can be safely called with an undefined frame in order to handle
 * single frame data. (eg frame is undefined is the same as frame===1).
 */
const combineFrameInstance = (frame, instance) => {
  const {
    PerFrameFunctionalGroupsSequence,
    SharedFunctionalGroupsSequence,
    NumberOfFrames,
    ImageType,
  } = instance;

  if (NumberOfFrames < 2) {
    return instance;
  }

  instance.ImageType = dicomSplit(ImageType);
  const frameNumber = Number.parseInt(frame || 1);

  const hasDetectorButMissingSpatialInfo =
    instance.DetectorInformationSequence &&
    (!instance.ImagePositionPatient || !instance.ImageOrientationPatient);

  if (
    (PerFrameFunctionalGroupsSequence && SharedFunctionalGroupsSequence) ||
    hasDetectorButMissingSpatialInfo || NumberOfFrames > 1
  ) {
    // this is to fix NM multiframe datasets with position and orientation
    // information inside DetectorInformationSequence
    if (!instance.ImageOrientationPatient && instance.DetectorInformationSequence) {
      instance.ImageOrientationPatient =
        instance.DetectorInformationSequence[0].ImageOrientationPatient;
    }

    let ImagePositionPatientToUse = instance.ImagePositionPatient;

    if (!instance.ImagePositionPatient && instance.DetectorInformationSequence) {
      let imagePositionPatient = instance.DetectorInformationSequence[0].ImagePositionPatient;
      let imageOrientationPatient = instance.ImageOrientationPatient;

      imagePositionPatient = imagePositionPatient?.map(it => Number(it));
      imageOrientationPatient = imageOrientationPatient?.map(it => Number(it));
      const SpacingBetweenSlices = Number(instance.SpacingBetweenSlices);

      // Auto-correct invalid position (e.g., from projection data with [0,0,Z] or X=Y=Z)
      const isInvalidPosition =
        !imagePositionPatient ||
        (imagePositionPatient[0] === 0 && imagePositionPatient[1] === 0) ||
        (imagePositionPatient[0] === imagePositionPatient[1] &&
         imagePositionPatient[1] === imagePositionPatient[2]);

      if (isInvalidPosition && SpacingBetweenSlices && NumberOfFrames) {
        // Get FOV from ReconstructionDiameter or calculate from pixel spacing
        const reconDiameter = instance.ReconstructionDiameter ? Number(instance.ReconstructionDiameter) : null;
        const pixelSpacing = instance.PixelSpacing?.map(it => Number(it)) || [SpacingBetweenSlices, SpacingBetweenSlices];
        const rows = instance.Rows || 128;
        const cols = instance.Columns || 128;

        // Calculate FOV
        const fov = reconDiameter || (cols * pixelSpacing[0]);
        const halfFov = fov / 2;
        const volumeDepth = NumberOfFrames * SpacingBetweenSlices;
        const halfDepth = volumeDepth / 2;

        // Get table positioning
        const tableHeight = instance.TableHeight ? Number(instance.TableHeight) : 0;
        const projZ = instance.DetectorInformationSequence?.[0]?.ImagePositionPatient?.[2]
          ? Number(instance.DetectorInformationSequence[0].ImagePositionPatient[2])
          : 0;

        // Calculate position using clinical scanner formula:
        // X = -FOV/2 (center horizontally)
        // Y = -FOV/2 - tableHeight (offset by table height)
        // Z = projZ - volumeDepth/2 - FOV/2 (offset from projection center)
        const posX = -halfFov;
        const posY = -halfFov - tableHeight;
        const posZ = projZ > 0 ? (projZ - halfDepth - halfFov) : (-halfDepth);

        imagePositionPatient = [posX, posY, posZ];
      }

      // Calculate the position for the current frame
      if (imageOrientationPatient && SpacingBetweenSlices) {
        const rowOrientation = vec3.fromValues(
          imageOrientationPatient[0],
          imageOrientationPatient[1],
          imageOrientationPatient[2]
        );

        const colOrientation = vec3.fromValues(
          imageOrientationPatient[3],
          imageOrientationPatient[4],
          imageOrientationPatient[5]
        );

        const normalVector = vec3.cross(vec3.create(), rowOrientation, colOrientation);

        const position = vec3.scaleAndAdd(
          vec3.create(),
          imagePositionPatient,
          normalVector,
          SpacingBetweenSlices * (frameNumber - 1)
        );

        ImagePositionPatientToUse = [position[0], position[1], position[2]];
      }
    }

    // Cache the _parentInstance at the top level as a full copy to prevent
    // setting values hard.
    if (!instance._parentInstance) {
      Object.defineProperty(instance, '_parentInstance', {
        value: { ...instance },
      });
    }
    const sharedInstance = createCombinedValue(
      instance._parentInstance,
      SharedFunctionalGroupsSequence?.[0],
      '_shared'
    );
    const newInstance = createCombinedValue(
      sharedInstance,
      PerFrameFunctionalGroupsSequence?.[frameNumber - 1],
      frameNumber
    );

    newInstance.ImagePositionPatient = ImagePositionPatientToUse ??
      newInstance.ImagePositionPatient ?? [0, 0, frameNumber];

    Object.defineProperty(newInstance, 'frameNumber', {
      value: frameNumber,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return newInstance;
  }

  // For RTDOSE datasets
  if (instance.GridFrameOffsetVector) {
    if (!instance._parentInstance) {
      Object.defineProperty(instance, '_parentInstance', {
        value: { ...instance },
      });
    }

    const sharedInstance = createCombinedValue(
      instance._parentInstance,
      SharedFunctionalGroupsSequence?.[0],
      '_shared'
    );

    const newInstance = createCombinedValue(
      sharedInstance,
      PerFrameFunctionalGroupsSequence?.[frameNumber - 1],
      frameNumber
    );

    const origin = newInstance.ImagePositionPatient?.map(Number);
    const orientation = newInstance.ImageOrientationPatient?.map(Number);
    const offset = Number(instance.GridFrameOffsetVector[frameNumber - 1]);

    if (origin && orientation && !Number.isNaN(offset)) {
      const row = vec3.fromValues(orientation[0], orientation[1], orientation[2]);
      const col = vec3.fromValues(orientation[3], orientation[4], orientation[5]);
      const normal = vec3.cross(vec3.create(), row, col);

      const position = vec3.scaleAndAdd(vec3.create(), vec3.fromValues(origin[0], origin[1], origin[2]), normal, offset);
      newInstance.ImagePositionPatient = [position[0], position[1], position[2]];
    }

    Object.defineProperty(newInstance, 'frameNumber', {
      value: frameNumber,
      writable: true,
      enumerable: true,
      configurable: true,
    });

    return newInstance;
  }

  return instance;
};

/**
 * Creates a combined instance stored in the parent object which
 * inherits from the parent instance the attributes in the functional groups.
 * The storage key in the parent is in key
 */
function createCombinedValue(parent, functionalGroups, key) {
  if (parent[key]) {
    return parent[key];
  }
  // Exclude any proxying values
  const newInstance = Object.create(parent);
  Object.defineProperty(parent, key, {
    value: newInstance,
    writable: false,
    enumerable: false,
  });
  if (!functionalGroups) {
    return newInstance;
  }
  const shared = functionalGroups
    ? Object.values(functionalGroups)
        .filter(Boolean)
        .map(it => it[0])
        .filter(it => typeof it === 'object')
    : [];

  // merge the shared first then the per frame to override
  [...shared].forEach(item => {
    if (item.SOPInstanceUID) {
      // This sub-item is a previous value information item, so don't merge it
      return;
    }
    Object.entries(item).forEach(([key, value]) => {
      newInstance[key] = value;
    });
  });
  return newInstance;
}

export default combineFrameInstance;
