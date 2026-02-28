import OHIF from '@ohif/core';

import { InstanceMetadata, PhilipsPETPrivateGroup } from '@cornerstonejs/calculate-suv/src/types';

const metadataProvider = OHIF.classes.MetadataProvider;

export default function getPTImageIdInstanceMetadata(imageId: string): InstanceMetadata {
  const dicomMetaData = metadataProvider.get('instance', imageId);

  if (!dicomMetaData) {
    throw new Error('dicom metadata are required');
  }

  // Basic required fields for all PT/NM modalities
  const requiredFields = [
    'SeriesDate',
    'SeriesTime', 
    'AcquisitionDate',
    'AcquisitionTime'
  ];

  // Check basic required fields
  for (const field of requiredFields) {
    if (dicomMetaData[field] === undefined) {
      throw new Error(`Required metadata field '${field}' is missing`);
    }
  }

  // For PT modality, check additional required fields
  if (dicomMetaData.Modality === 'PT') {
    if (
      dicomMetaData.CorrectedImage === undefined ||
      dicomMetaData.Units === undefined ||
      !dicomMetaData.RadiopharmaceuticalInformationSequence ||
      dicomMetaData.RadiopharmaceuticalInformationSequence.RadionuclideHalfLife === undefined ||
      dicomMetaData.RadiopharmaceuticalInformationSequence.RadionuclideTotalDose === undefined ||
      dicomMetaData.DecayCorrection === undefined ||
      (dicomMetaData.RadiopharmaceuticalInformationSequence.RadiopharmaceuticalStartDateTime ===
        undefined &&
        dicomMetaData.RadiopharmaceuticalInformationSequence.RadiopharmaceuticalStartTime ===
          undefined)
    ) {
      throw new Error('required PT metadata are missing');
    }
  }

  // For NM/SPECT, use basic metadata if available
  const instanceMetadata: InstanceMetadata = {
    CorrectedImage: dicomMetaData.CorrectedImage || '',
    Units: dicomMetaData.Units || 'CNTS',
    RadionuclideHalfLife: dicomMetaData.RadiopharmaceuticalInformationSequence?.RadionuclideHalfLife || 0,
    RadionuclideTotalDose: dicomMetaData.RadiopharmaceuticalInformationSequence?.RadionuclideTotalDose || 0,
    RadiopharmaceuticalStartDateTime: dicomMetaData.RadiopharmaceuticalInformationSequence?.RadiopharmaceuticalStartDateTime,
    RadiopharmaceuticalStartTime: dicomMetaData.RadiopharmaceuticalInformationSequence?.RadiopharmaceuticalStartTime,
    DecayCorrection: dicomMetaData.DecayCorrection || 'NONE',
    PatientWeight: dicomMetaData.PatientWeight,
    SeriesDate: dicomMetaData.SeriesDate,
    SeriesTime: dicomMetaData.SeriesTime,
    AcquisitionDate: dicomMetaData.AcquisitionDate,
    AcquisitionTime: dicomMetaData.AcquisitionTime,
  };

  if (dicomMetaData.PatientWeight === undefined) {
    console.warn('PatientWeight missing from instance metadata');
  }

  if (
    dicomMetaData['70531000'] ||
    dicomMetaData['70531000'] !== undefined ||
    dicomMetaData['70531009'] ||
    dicomMetaData['70531009'] !== undefined
  ) {
    const philipsPETPrivateGroup: PhilipsPETPrivateGroup = {
      SUVScaleFactor: dicomMetaData['70531000'],
      ActivityConcentrationScaleFactor: dicomMetaData['70531009'],
    };
    instanceMetadata.PhilipsPETPrivateGroup = philipsPETPrivateGroup;
  }

  if (dicomMetaData['0009100d'] && dicomMetaData['0009100d'] !== undefined) {
    instanceMetadata.GEPrivatePostInjectionDateTime = dicomMetaData['0009100d'];
  }

  if (dicomMetaData.FrameReferenceTime && dicomMetaData.FrameReferenceTime !== undefined) {
    instanceMetadata.FrameReferenceTime = dicomMetaData.FrameReferenceTime;
  }

  if (dicomMetaData.ActualFrameDuration && dicomMetaData.ActualFrameDuration !== undefined) {
    instanceMetadata.ActualFrameDuration = dicomMetaData.ActualFrameDuration;
  }

  if (dicomMetaData.PatientSex && dicomMetaData.PatientSex !== undefined) {
    instanceMetadata.PatientSex = dicomMetaData.PatientSex;
  }

  if (dicomMetaData.PatientSize && dicomMetaData.PatientSize !== undefined) {
    instanceMetadata.PatientSize = dicomMetaData.PatientSize;
  }

  return instanceMetadata;
}

function convertInterfaceTimeToString(time): string {
  const hours = `${time.hours || '00'}`.padStart(2, '0');
  const minutes = `${time.minutes || '00'}`.padStart(2, '0');
  const seconds = `${time.seconds || '00'}`.padStart(2, '0');

  const fractionalSeconds = `${time.fractionalSeconds || '000000'}`.padEnd(6, '0');

  const timeString = `${hours}${minutes}${seconds}.${fractionalSeconds}`;
  return timeString;
}

function convertInterfaceDateToString(date): string {
  const month = `${date.month}`.padStart(2, '0');
  const day = `${date.day}`.padStart(2, '0');
  const dateString = `${date.year}${month}${day}`;
  return dateString;
}

export { getPTImageIdInstanceMetadata };
