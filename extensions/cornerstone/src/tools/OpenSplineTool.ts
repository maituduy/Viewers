import { BaseCPRTool } from './BaseCPRTool';

/**
 * OpenSpline Tool - Manual spline drawing with CPR generation
 * User manually draws all control points
 */
class OpenSplineTool extends BaseCPRTool {
  static toolName = 'OpenSpline';

  cancel(element: HTMLDivElement) {
    return super.cancel(element);
  }
}

export default OpenSplineTool;
