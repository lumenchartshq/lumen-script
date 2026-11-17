import type { CompiledProgram } from "../compiler/index.js";
import type { PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { integer, isNa, number, pineString } from "./values.js";
import { isStrictPineCompatibility } from "../contracts/index.js";

/** The reference platform allows five extra live drawings before evicting six in creation order. */
function evictOldestDrawings(drawings: readonly { deleted: boolean }[], limit: number, strict: boolean): void {
  const active = drawings.filter((drawing) => !drawing.deleted);
  const allowance = strict ? 5 : 0;
  if (active.length <= limit + allowance) return;
  const evicted = active.slice(0, strict ? active.length - limit : 1);
  for (const drawing of evicted) drawing.deleted = true;
}

export interface MutablePineLine {
  [key: string]: PineValue;
  __pineLine: true;
  id: number;
  order: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  xloc: string;
  extend: string;
  color: PineValue;
  style: string;
  width: number;
  forceOverlay: boolean;
  deleted: boolean;
}

export interface MutablePineBox {
  [key: string]: PineValue;
  __pineBox: true;
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  xloc: string;
  extend: string;
  borderColor: PineValue;
  borderStyle: string;
  borderWidth: number;
  backgroundColor: PineValue;
  text: string;
  textColor: PineValue;
  textSize: string;
  textHorizontalAlign: string;
  textVerticalAlign: string;
  textWrap: string;
  textFontFamily: string;
  textFormatting: string;
  forceOverlay: boolean;
  deleted: boolean;
}

export interface MutablePineLabel {
  [key: string]: PineValue;
  __pineLabel: true;
  id: number;
  x: number;
  y: number;
  text: string;
  xloc: string;
  yloc: string;
  color: PineValue;
  style: string;
  textColor: PineValue;
  size: string;
  textAlign: string;
  tooltip: string;
  textFontFamily: string;
  textFormatting: string;
  forceOverlay: boolean;
  deleted: boolean;
}

export interface MutableChartPoint {
  [key: string]: PineValue;
  __pineChartPoint: true;
  time: PineValue;
  index: PineValue;
  price: number;
}

export interface MutablePinePolyline {
  [key: string]: PineValue;
  __pinePolyline: true;
  id: number;
  order: number;
  points: MutableChartPoint[];
  curved: boolean;
  closed: boolean;
  xloc: string;
  lineColor: PineValue;
  fillColor: PineValue;
  lineStyle: string;
  lineWidth: number;
  forceOverlay: boolean;
  deleted: boolean;
}

export interface MutablePineLinefill {
  [key: string]: PineValue;
  __pineLinefill: true;
  id: number;
  line1: MutablePineLine;
  line2: MutablePineLine;
  color: PineValue;
  deleted: boolean;
}

export interface MutableTableCell {
  [key: string]: PineValue;
  text: string;
  width: number;
  height: number;
  textColor: PineValue;
  textHorizontalAlign: string;
  textVerticalAlign: string;
  textSize: PineValue;
  backgroundColor: PineValue;
  tooltip: string;
  textFontFamily: string;
  textFormatting: string;
  merged: boolean;
  mergeParent: readonly [number, number] | null;
}

export interface MutablePineTable {
  [key: string]: PineValue;
  __pineTable: true;
  id: number;
  position: string;
  columns: number;
  rows: number;
  backgroundColor: PineValue;
  frameColor: PineValue;
  frameWidth: number;
  borderColor: PineValue;
  borderWidth: number;
  forceOverlay: boolean;
  cells: (MutableTableCell | null)[][];
  merges: { startColumn: number; startRow: number; endColumn: number; endRow: number }[];
  deleted: boolean;
}

export class DrawingRuntime {
  public nextVisualOrder = 0;
  public readonly lines: MutablePineLine[] = [];
  public nextLineId = 0;
  public readonly boxes: MutablePineBox[] = [];
  public nextBoxId = 0;
  public readonly labels: MutablePineLabel[] = [];
  public nextLabelId = 0;
  public readonly polylines: MutablePinePolyline[] = [];
  public nextPolylineId = 0;
  public readonly linefills: MutablePineLinefill[] = [];
  public nextLinefillId = 0;
  public readonly tables: MutablePineTable[] = [];
  public nextTableId = 0;

  public constructor(
    private readonly program: CompiledProgram,
    private readonly currentPoint: () => { readonly time: PineValue; readonly index: number },
    private readonly maxTableCells = Number.POSITIVE_INFINITY,
  ) {}

  public reset(): void {
    this.nextVisualOrder = 0;
    this.lines.length = 0;
    this.nextLineId = 0;
    this.boxes.length = 0;
    this.nextBoxId = 0;
    this.labels.length = 0;
    this.nextLabelId = 0;
    this.polylines.length = 0;
    this.nextPolylineId = 0;
    this.linefills.length = 0;
    this.nextLinefillId = 0;
    this.tables.length = 0;
    this.nextTableId = 0;
  }

  private truthy(value: PineValue): boolean {
    return !isNa(value) && Boolean(value);
  }

  private get strictTableLimits(): boolean {
    return isStrictPineCompatibility(this.program.compatibility);
  }

  private ownsLiveLine(value: PineValue | undefined): value is MutablePineLine {
    return isPineLine(value) && this.lines.includes(value) && !value.deleted;
  }

  private ownsLiveLinefill(value: PineValue | undefined): value is MutablePineLinefill {
    return isPineLinefill(value) && this.linefills.includes(value) && !value.deleted
      && this.ownsLiveLine(value.line1) && this.ownsLiveLine(value.line2);
  }

  public ownsCastReference(name: string, value: PineValue): boolean {
    if (name === "line") return isPineLine(value) && this.lines.includes(value);
    if (name === "box") return isPineBox(value) && this.boxes.includes(value);
    if (name === "label") return isPineLabel(value) && this.labels.includes(value);
    if (name === "linefill") return isPineLinefill(value) && this.linefills.includes(value);
    if (name === "table") return isPineTable(value) && this.tables.includes(value);
    return false;
  }

  private tablePosition(value: PineValue | undefined): string {
    const position = pineString(value ?? "top_right");
    if (this.strictTableLimits && !TABLE_POSITIONS.has(position)) {
      throw new Error(`Invalid table position '${position}'`);
    }
    return position;
  }

  private tableTextSize(value: PineValue): PineValue {
    if (!this.strictTableLimits) return value;
    if (typeof value === "string" && TABLE_TEXT_SIZES.has(value)) return value;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    throw new Error("Table text_size must be a supported size string or nonnegative integer");
  }

  public lineCall(name: string, args: readonly PineValue[]): PineValue {
    if (name === "new") {
      const firstPoint = isChartPoint(args[0]) ? args[0] : undefined;
      const secondPoint = isChartPoint(args[1]) ? args[1] : undefined;
      const pointOverload = firstPoint !== undefined;
      const strict = isStrictPineCompatibility(this.program.compatibility);
      const requestedXloc = args[pointOverload ? 2 : 4];
      let xloc = "bi";
      if (requestedXloc !== undefined) xloc = pineString(requestedXloc);
      else if (!strict && pointOverload) xloc = chartPointXloc(firstPoint);
      const pointX = (point: MutableChartPoint | undefined): number => {
        if (!strict) return chartPointX(point);
        const coordinate = xloc === "bt" ? point?.time : point?.index;
        return typeof coordinate === "number" ? coordinate : Number.NaN;
      };
      const line: MutablePineLine = {
        __pineLine: true,
        id: this.nextLineId++,
        order: this.nextVisualOrder++,
        x1: pointOverload ? pointX(firstPoint) : number(args[0]), y1: pointOverload ? firstPoint.price : number(args[1]),
        x2: pointOverload ? pointX(secondPoint) : number(args[2]), y2: pointOverload ? secondPoint?.price ?? Number.NaN : number(args[3]),
        xloc,
        extend: pineString(args[pointOverload ? 3 : 5] ?? "none"), color: args[pointOverload ? 4 : 6] ?? (strict ? "#2962ff" : ""),
        style: pineString(args[pointOverload ? 5 : 7] ?? "style_solid"), width: Math.max(1, integer(args[pointOverload ? 6 : 8] ?? 1)),
        forceOverlay: this.truthy(args[pointOverload ? 7 : 9] ?? false), deleted: false,
      };
      this.lines.push(line);
      evictOldestDrawings(this.lines, this.program.descriptor.drawingLimits.lines, strict);
      return line;
    }
    const line = isPineLine(args[0]) ? args[0] : undefined;
    if (name === "copy") {
      if (line === undefined || (isStrictPineCompatibility(this.program.compatibility) && line.deleted)) return Number.NaN;
      return this.lineCall("new", [line.x1, line.y1, line.x2, line.y2, line.xloc, line.extend, line.color, line.style, line.width, line.forceOverlay]);
    }
    if (name === "delete") {
      if (line !== undefined) {
        line.deleted = true;
        if (this.strictTableLimits) for (const fill of this.linefills) {
          if (fill.line1 === line || fill.line2 === line) fill.deleted = true;
        }
      }
      return null;
    }
    if (line === undefined || line.deleted) {
      if (isStrictPineCompatibility(this.program.compatibility) && name.startsWith("set_")) return null;
      return Number.NaN;
    }
    if (name === "set_x1") line.x1 = number(args[1]);
    else if (name === "set_y1") line.y1 = number(args[1]);
    else if (name === "set_x2") line.x2 = number(args[1]);
    else if (name === "set_y2") line.y2 = number(args[1]);
    else if (name === "set_xy1") { line.x1 = number(args[1]); line.y1 = number(args[2]); }
    else if (name === "set_xy2") { line.x2 = number(args[1]); line.y2 = number(args[2]); }
    else if (name === "set_color") line.color = args[1] ?? Number.NaN;
    else if (name === "set_width") line.width = Math.max(1, integer(args[1] ?? 1));
    else if (name === "set_style") line.style = pineString(args[1]);
    else if (name === "set_extend") line.extend = pineString(args[1]);
    else if (name === "set_xloc") { line.x1 = number(args[1]); line.x2 = number(args[2]); line.xloc = pineString(args[3]); }
    else if (name === "set_first_point" && isChartPoint(args[1])) {
      line.x1 = isStrictPineCompatibility(this.program.compatibility) ? linePointX(args[1], line.xloc) : chartPointX(args[1]);
      line.y1 = args[1].price;
      if (!isStrictPineCompatibility(this.program.compatibility)) line.xloc = chartPointXloc(args[1]);
    }
    else if (name === "set_second_point" && isChartPoint(args[1])) {
      line.x2 = isStrictPineCompatibility(this.program.compatibility) ? linePointX(args[1], line.xloc) : chartPointX(args[1]);
      line.y2 = args[1].price;
      if (!isStrictPineCompatibility(this.program.compatibility)) line.xloc = chartPointXloc(args[1]);
    }
    else if (name === "get_x1") return line.x1;
    else if (name === "get_y1") return line.y1;
    else if (name === "get_x2") return line.x2;
    else if (name === "get_y2") return line.y2;
    else if (name === "get_price") {
      if (line.xloc !== "bi") {
        if (isStrictPineCompatibility(this.program.compatibility)) throw new PineRuntimeError("line.get_price requires xloc.bar_index", "line.get_price");
        return Number.NaN;
      }
      const dx = line.x2 - line.x1;
      if (dx === 0) {
        if (isStrictPineCompatibility(this.program.compatibility)) return Number.NaN;
        return line.y1;
      }
      return line.y1 + (number(args[1]) - line.x1) / dx * (line.y2 - line.y1);
    } else throw new Error(`Unsupported line call line.${name}`);
    return null;
  }

  public boxCall(name: string, args: readonly PineValue[]): PineValue {
    const strict = isStrictPineCompatibility(this.program.compatibility);
    const enumValue = (value: PineValue | undefined, allowed: readonly string[], parameter: string): string => {
      const actual = pineString(value);
      if (strict && !allowed.includes(actual)) throw new PineRuntimeError(`box.${name} requires a valid ${parameter}`, `box.${name}`);
      return actual;
    };
    const xlocValue = (value: PineValue | undefined) => enumValue(value, ["bi", "bt"], "xloc");
    const extendValue = (value: PineValue | undefined) => enumValue(value, ["n", "l", "r", "b"], "extend");
    const styleValue = (value: PineValue | undefined) => enumValue(value, ["style_solid", "style_dashed", "style_dotted"], "border_style");
    const sizeValue = (value: PineValue | undefined): string => {
      if (strict && typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
          throw new PineRuntimeError(`box.${name} requires text_size from 0 to 100`, `box.${name}`);
        }
        return value === 0 ? "auto" : String(value);
      }
      return enumValue(value, ["auto", "tiny", "small", "normal", "large", "huge"], "text_size");
    };
    const alignValue = (value: PineValue | undefined, vertical = false) => enumValue(value, vertical ? ["top", "center", "bottom"] : ["left", "center", "right"], vertical ? "text_valign" : "text_halign");
    const wrapValue = (value: PineValue | undefined) => enumValue(value, ["auto", "none", "wrap_auto", "wrap_none"], "text_wrap");
    const familyValue = (value: PineValue | undefined) => enumValue(value, ["default", "monospace"], "text_font_family");
    const formattingValue = (value: PineValue | undefined) => enumValue(value, ["format_none", "format_bold", "format_italic", "format_bold_italic"], "text_formatting");
    const coordinate = (value: PineValue | undefined, parameter: string): number => {
      if (strict && typeof value !== "number" && !isNa(value)) throw new PineRuntimeError(`box.${name} requires numeric ${parameter}`, `box.${name}`);
      return number(value);
    };
    const pointCoordinate = (point: MutableChartPoint | undefined, mode: string): number => {
      if (point === undefined) return Number.NaN;
      return strict ? linePointX(point, mode) : chartPointX(point);
    };
    if (name === "new") {
      const topLeft = isChartPoint(args[0]) ? args[0] : undefined;
      const bottomRight = isChartPoint(args[1]) ? args[1] : undefined;
      const pointOverload = topLeft !== undefined;
      const xloc = xlocValue(args[pointOverload ? 6 : 8] ?? (pointOverload && !strict ? chartPointXloc(topLeft) : "bi"));
      const borderStyle = styleValue(args[pointOverload ? 4 : 6] ?? "style_solid");
      const extend = extendValue(args[pointOverload ? 5 : 7] ?? (strict ? "n" : "none"));
      const textSize = sizeValue(args[pointOverload ? 9 : 11] ?? "auto");
      const textHorizontalAlign = alignValue(args[pointOverload ? 11 : 13] ?? "center");
      const textVerticalAlign = alignValue(args[pointOverload ? 12 : 14] ?? "center", true);
      // text.wrap_none resolves to "none"; the default must report the same value.
      const textWrap = wrapValue(args[pointOverload ? 13 : 15] ?? (strict ? "none" : "wrap_none"));
      const textFontFamily = familyValue(args[pointOverload ? 14 : 16] ?? "default");
      const textFormatting = formattingValue(args[pointOverload ? 16 : 18] ?? "format_none");
      const box: MutablePineBox = {
        __pineBox: true, id: this.nextBoxId, left: pointOverload ? pointCoordinate(topLeft, xloc) : coordinate(args[0], "left"),
        top: pointOverload ? topLeft.price : coordinate(args[1], "top"), right: pointOverload ? pointCoordinate(bottomRight, xloc) : coordinate(args[2], "right"),
        bottom: pointOverload ? bottomRight?.price ?? Number.NaN : coordinate(args[3], "bottom"),
        borderColor: args[pointOverload ? 2 : 4] ?? "#2962ff", borderWidth: coordinate(args[pointOverload ? 3 : 5] ?? 1, "border_width"),
        borderStyle, extend, xloc,
        backgroundColor: args[pointOverload ? 7 : 9] ?? "#2962ff", text: pineString(args[pointOverload ? 8 : 10] ?? ""),
        textSize, textColor: args[pointOverload ? 10 : 12] ?? (strict ? "#ffffff" : "#000000"),
        textHorizontalAlign, textVerticalAlign, textWrap, textFontFamily,
        forceOverlay: this.truthy(args[pointOverload ? 15 : 17] ?? false), textFormatting, deleted: false,
      };
      this.nextBoxId += 1;
      this.boxes.push(box);
      evictOldestDrawings(this.boxes, this.program.descriptor.drawingLimits.boxes, strict);
      return box;
    }
    const box = isPineBox(args[0]) ? args[0] : undefined;
    if (name === "copy") {
      if (box === undefined || (strict && box.deleted)) return Number.NaN;
      const copiedSize = strict && /^(?:[1-9]\d?|100)$/u.test(box.textSize) ? Number(box.textSize) : box.textSize;
      const copy = this.boxCall("new", [box.left, box.top, box.right, box.bottom, box.borderColor, box.borderWidth, box.borderStyle, box.extend, box.xloc, box.backgroundColor, box.text, copiedSize, box.textColor, box.textHorizontalAlign, box.textVerticalAlign, box.textWrap, box.textFontFamily, box.forceOverlay, box.textFormatting]);
      if (isPineBox(copy)) copy.textFormatting = box.textFormatting;
      return copy;
    }
    if (name === "delete") { if (box !== undefined) box.deleted = true; return null; }
    if (box === undefined || box.deleted) return strict && name.startsWith("set_") ? null : Number.NaN;
    if (name === "set_left") box.left = coordinate(args[1], "left");
    else if (name === "set_right") box.right = coordinate(args[1], "right");
    else if (name === "set_top") box.top = coordinate(args[1], "top");
    else if (name === "set_bottom") box.bottom = coordinate(args[1], "bottom");
    else if (name === "set_lefttop") { const left = coordinate(args[1], "left"); const top = coordinate(args[2], "top"); box.left = left; box.top = top; }
    else if (name === "set_rightbottom") { const right = coordinate(args[1], "right"); const bottom = coordinate(args[2], "bottom"); box.right = right; box.bottom = bottom; }
    else if (name === "set_xloc") { const left = coordinate(args[1], "left"); const right = coordinate(args[2], "right"); const mode = xlocValue(args[3]); box.left = left; box.right = right; box.xloc = mode; }
    else if (name === "set_top_left_point" && isChartPoint(args[1])) { box.left = pointCoordinate(args[1], box.xloc); box.top = args[1].price; if (!strict) box.xloc = chartPointXloc(args[1]); }
    else if (name === "set_bottom_right_point" && isChartPoint(args[1])) { box.right = pointCoordinate(args[1], box.xloc); box.bottom = args[1].price; if (!strict) box.xloc = chartPointXloc(args[1]); }
    else if (name === "set_bgcolor") box.backgroundColor = args[1] ?? Number.NaN;
    else if (name === "set_border_color") box.borderColor = args[1] ?? Number.NaN;
    else if (name === "set_border_width") box.borderWidth = coordinate(args[1] ?? 1, "border_width");
    else if (name === "set_border_style") box.borderStyle = styleValue(args[1]);
    else if (name === "set_extend") box.extend = extendValue(args[1]);
    else if (name === "set_text") box.text = pineString(args[1] ?? "");
    else if (name === "set_text_color") box.textColor = args[1] ?? Number.NaN;
    else if (name === "set_text_size") box.textSize = sizeValue(args[1]);
    else if (name === "set_text_halign") box.textHorizontalAlign = alignValue(args[1]);
    else if (name === "set_text_valign") box.textVerticalAlign = alignValue(args[1], true);
    else if (name === "set_text_wrap") box.textWrap = wrapValue(args[1]);
    else if (name === "set_text_font_family") box.textFontFamily = familyValue(args[1]);
    else if (name === "set_text_formatting") box.textFormatting = formattingValue(args[1]);
    else if (name === "get_left") return box.left;
    else if (name === "get_right") return box.right;
    else if (name === "get_top") return box.top;
    else if (name === "get_bottom") return box.bottom;
    else throw new Error(`Unsupported box call box.${name}`);
    return null;
  }

  public labelCall(name: string, args: readonly PineValue[]): PineValue {
    const strict = isStrictPineCompatibility(this.program.compatibility);
    if (name === "new") {
      const point = isChartPoint(args[0]) ? args[0] : undefined;
      const pointOverload = point !== undefined;
      const at = (pointIndex: number, numericIndex: number) => args[pointOverload ? pointIndex : numericIndex];
      const defaultXloc = pointOverload && !strict ? chartPointXloc(point) : "bi";
      const xloc = labelOption(at(2, 3), "xloc", defaultXloc, strict);
      const yloc = labelOption(at(3, 4), "yloc", "pr", strict);
      let x: number;
      if (point !== undefined) x = strict ? labelPointX(point, xloc) : chartPointX(point);
      else x = labelNumber(args[0], "x", true, strict);
      const y = pointOverload ? labelNumber(point.price, "y", false, strict) : labelNumber(args[1], "y", false, strict);
      const text = labelText(at(1, 2), "text", "", strict);
      const color = labelColor(at(4, 5), "color", strict ? "#2962ff" : "", strict);
      const style = labelOption(at(5, 6), "style", "style_label_down", strict);
      const textColor = labelColor(at(6, 7), "textcolor", strict ? "#ffffff" : "", strict);
      const size = labelSize(at(7, 8), strict);
      const textAlign = labelOption(at(8, 9), "textalign", "center", strict);
      const tooltip = labelText(at(9, 10), "tooltip", "", strict);
      const textFontFamily = labelOption(at(10, 11), "text_font_family", "default", strict);
      const forceOverlayValue = at(11, 12);
      if (strict && forceOverlayValue !== undefined && typeof forceOverlayValue !== "boolean") throw new PineRuntimeError("label.new requires a boolean force_overlay", "label.new");
      const textFormatting = pineString(at(12, 13) ?? "format_none");
      const label: MutablePineLabel = {
        __pineLabel: true, id: this.nextLabelId++, x, y, text, xloc, yloc, color, style, textColor,
        size, textAlign, tooltip, textFontFamily, forceOverlay: this.truthy(forceOverlayValue ?? false), textFormatting, deleted: false,
      };
      return this.retainLabel(label);
    }
    const label = isPineLabel(args[0]) ? args[0] : undefined;
    if (name === "copy") {
      if (label === undefined || (strict && label.deleted)) return Number.NaN;
      return this.retainLabel({ ...label, id: this.nextLabelId++, deleted: false });
    }
    if (name === "delete") { if (label !== undefined) label.deleted = true; return null; }
    if (label === undefined || label.deleted) {
      if (strict && name.startsWith("set_")) return null;
      if (strict && name === "get_text") return "";
      return Number.NaN;
    }
    if (name === "set_x") label.x = labelNumber(args[1], "x", true, strict);
    else if (name === "set_y") label.y = labelNumber(args[1], "y", false, strict);
    else if (name === "set_xy") {
      const x = labelNumber(args[1], "x", true, strict);
      const y = labelNumber(args[2], "y", false, strict);
      label.x = x; label.y = y;
    }
    else if (name === "set_text") label.text = labelText(args[1], "text", "", strict);
    else if (name === "set_color") label.color = labelColor(args[1], "color", Number.NaN, strict);
    else if (name === "set_textcolor") label.textColor = labelColor(args[1], "textcolor", Number.NaN, strict);
    else if (name === "set_size") label.size = labelSize(args[1], strict);
    else if (name === "set_style") label.style = labelOption(args[1], "style", "style_label_down", strict);
    else if (name === "set_textalign") label.textAlign = labelOption(args[1], "textalign", "center", strict);
    else if (name === "set_tooltip") label.tooltip = labelText(args[1], "tooltip", "", strict);
    else if (name === "set_xloc") {
      if (strict) {
        const x = labelNumber(args[1], "x", true, strict);
        const xloc = labelOption(args[2], "xloc", "bi", strict);
        label.x = x; label.xloc = xloc;
      } else label.xloc = labelOption(args[1], "xloc", "bi", strict);
    }
    else if (name === "set_yloc") label.yloc = labelOption(args[1], "yloc", "pr", strict);
    else if (name === "set_text_font_family") label.textFontFamily = labelOption(args[1], "text_font_family", "default", strict);
    else if (name === "set_text_formatting") label.textFormatting = pineString(args[1]);
    else if (name === "set_point") {
      if (!isChartPoint(args[1])) {
        if (strict) throw new PineRuntimeError("label.set_point requires a chart.point", "label.set_point");
      } else {
        const x = strict ? labelPointX(args[1], label.xloc) : chartPointX(args[1]);
        const y = labelNumber(args[1].price, "point.price", false, strict);
        label.x = x; label.y = y;
        if (!strict) label.xloc = chartPointXloc(args[1]);
      }
    }
    else if (name === "get_x") return label.x;
    else if (name === "get_y") return label.y;
    else if (name === "get_text") return label.text;
    else throw new Error(`Unsupported label call label.${name}`);
    return null;
  }

  private retainLabel(label: MutablePineLabel): MutablePineLabel {
    this.labels.push(label);
    evictOldestDrawings(this.labels, this.program.descriptor.drawingLimits.labels, isStrictPineCompatibility(this.program.compatibility));
    return label;
  }

  public chartPointCall(name: string, args: readonly PineValue[]): PineValue {
    if (name === "new") return chartPoint(args[0], args[1], args[2]);
    if (name === "from_index") return chartPoint(null, args[0], args[1]);
    if (name === "from_time") return chartPoint(args[0], null, args[1]);
    if (name === "now") {
      const point = this.currentPoint();
      return chartPoint(point.time, point.index, args[0]);
    }
    if (name === "copy") {
      const point = isChartPoint(args[0]) ? args[0] : undefined;
      return point === undefined ? Number.NaN : chartPoint(point.time, point.index, point.price);
    }
    throw new Error(`Unsupported chart point call chart.point.${name}`);
  }

  public polylineCall(name: string, args: readonly PineValue[]): PineValue {
    if (name === "new") {
      if (this.strictTableLimits) {
        const input = args[0];
        const xloc = args[3] ?? "bi";
        const style = args[6] ?? "style_solid";
        const width = args[7] ?? 1;
        if (!Array.isArray(input) || input.length > 10_000 || !input.every(isChartPoint)) {
          throw new PineRuntimeError("polyline.new requires an array of at most 10000 chart points", "polyline.new");
        }
        if (xloc !== "bi" && xloc !== "bt") throw new PineRuntimeError("polyline.new requires a valid xloc", "polyline.new");
        if (typeof style !== "string" || !["style_solid", "style_dashed", "style_dotted"].includes(style)) {
          throw new PineRuntimeError("polyline.new requires a supported line_style", "polyline.new");
        }
        if (typeof width !== "number" || !Number.isSafeInteger(width) || width < 1) {
          throw new PineRuntimeError("polyline.new requires a positive line_width", "polyline.new");
        }
        if ((args[1] !== undefined && typeof args[1] !== "boolean")
          || (args[2] !== undefined && typeof args[2] !== "boolean")
          || (args[8] !== undefined && typeof args[8] !== "boolean")
          || !validPineDrawingColor(args[4]) || !validPineDrawingColor(args[5])) {
          throw new PineRuntimeError("polyline.new requires valid flags and colors", "polyline.new");
        }
        if (!input.every((point) => {
          const anchor = xloc === "bt" ? point.time : point.index;
          return typeof anchor === "number" && Number.isFinite(anchor) && Number.isFinite(point.price);
        })) throw new PineRuntimeError("polyline.new requires finite points in the selected xloc", "polyline.new");
      }
      const points = Array.isArray(args[0]) ? (args[0] as readonly PineValue[]).filter(isChartPoint).map((point) => chartPoint(point.time, point.index, point.price)) : [];
      const polyline: MutablePinePolyline = {
        __pinePolyline: true, id: this.nextPolylineId++, order: this.nextVisualOrder++, points, curved: this.truthy(args[1] ?? false),
        closed: this.truthy(args[2] ?? false), xloc: pineString(args[3] ?? "bi"), lineColor: args[4] ?? "#2962ff",
        fillColor: args[5] ?? (this.strictTableLimits ? Number.NaN : ""), lineStyle: pineString(args[6] ?? "style_solid"), lineWidth: Math.max(1, integer(args[7] ?? 1)),
        forceOverlay: this.truthy(args[8] ?? false), deleted: false,
      };
      this.polylines.push(polyline);
      evictOldestDrawings(this.polylines, this.program.descriptor.drawingLimits.polylines, this.strictTableLimits);
      return polyline;
    }
    const polyline = isPinePolyline(args[0]) ? args[0] : undefined;
    if (name === "delete") {
      if (polyline !== undefined && (!this.strictTableLimits || this.polylines.includes(polyline))) polyline.deleted = true;
      return null;
    }
    throw new Error(`Unsupported polyline call polyline.${name}`);
  }

  public linefillCall(name: string, args: readonly PineValue[]): PineValue {
    if (name === "new") {
      const line1 = isPineLine(args[0]) ? args[0] : undefined;
      const line2 = isPineLine(args[1]) ? args[1] : undefined;
      if (line1 === undefined || line2 === undefined) return Number.NaN;
      if (this.strictTableLimits && (!this.ownsLiveLine(line1) || !this.ownsLiveLine(line2))) return Number.NaN;
      if (this.strictTableLimits && !validPineDrawingColor(args[2])) {
        throw new PineRuntimeError("linefill.new requires a color", "linefill.new");
      }
      const sameLine = (stored: MutablePineLine, candidate: MutablePineLine) => this.strictTableLimits
        ? stored === candidate : stored.id === candidate.id;
      const existing = this.linefills.find((linefill) => !linefill.deleted && (
        (sameLine(linefill.line1, line1) && sameLine(linefill.line2, line2))
        || (sameLine(linefill.line1, line2) && sameLine(linefill.line2, line1))
      ));
      if (existing !== undefined) {
        if (this.strictTableLimits) existing.deleted = true;
        else { existing.color = args[2] ?? Number.NaN; return existing; }
      }
      const linefill: MutablePineLinefill = {
        __pineLinefill: true, id: this.nextLinefillId++, line1, line2, color: args[2] ?? Number.NaN, deleted: false,
      };
      this.linefills.push(linefill);
      return linefill;
    }
    const linefill = isPineLinefill(args[0]) ? args[0] : undefined;
    if (name === "delete") {
      if (linefill !== undefined && (!this.strictTableLimits || this.linefills.includes(linefill))) linefill.deleted = true;
      return null;
    }
    if (linefill === undefined || linefill.deleted || (this.strictTableLimits && !this.ownsLiveLinefill(linefill))) {
      return this.strictTableLimits && name === "set_color" ? null : Number.NaN;
    }
    if (name === "set_color") {
      if (this.strictTableLimits && !validPineDrawingColor(args[1])) {
        throw new PineRuntimeError("linefill.set_color requires a color", "linefill.set_color");
      }
      linefill.color = args[1] ?? Number.NaN;
      return null;
    }
    if (name === "get_line1") return linefill.line1;
    if (name === "get_line2") return linefill.line2;
    throw new Error(`Unsupported linefill call linefill.${name}`);
  }

  public tableCall(name: string, args: readonly PineValue[]): PineValue {
    if (name === "new") {
      const columns = tableDimension(args[1] ?? 1, "columns", this.strictTableLimits);
      const rows = tableDimension(args[2] ?? 1, "rows", this.strictTableLimits);
      const position = this.tablePosition(args[0]);
      const allocatedCells = this.tables
        .filter((table) => !table.deleted)
        .reduce((total, table) => total + table.columns * table.rows, 0);
      if (this.strictTableLimits && allocatedCells + columns * rows > this.maxTableCells) {
        throw new Error(`Table cell limit exceeded: Lumen Script supports at most ${String(this.maxTableCells)} active table cells`);
      }
      const table: MutablePineTable = {
        __pineTable: true, id: this.nextTableId++, position, columns, rows,
        backgroundColor: args[3] ?? "", frameColor: args[4] ?? "", frameWidth: integer(args[5] ?? 0),
        borderColor: args[6] ?? "", borderWidth: integer(args[7] ?? 0), forceOverlay: this.truthy(args[8] ?? false),
        cells: Array.from({ length: rows }, () => Array.from({ length: columns }, () => null)), merges: [], deleted: false,
      };
      this.tables.push(table);
      return table;
    }
    const table = isPineTable(args[0]) ? args[0] : undefined;
    if (name === "delete") { if (table !== undefined) table.deleted = true; return null; }
    if (table === undefined || table.deleted) return Number.NaN;
    if (name === "cell") {
      const textSize = this.tableTextSize(args[9] ?? "normal");
      const cell = tableCell(table, tableCoordinate(args[1], "column", this.strictTableLimits), tableCoordinate(args[2], "row", this.strictTableLimits), true, this.strictTableLimits);
      if (cell !== undefined) Object.assign(cell, {
        text: pineString(args[3] ?? ""), width: number(args[4] ?? 0), height: number(args[5] ?? 0), textColor: args[6] ?? (this.strictTableLimits ? "#363A45" : "#000000"),
        textHorizontalAlign: pineString(args[7] ?? "center"), textVerticalAlign: pineString(args[8] ?? "center"),
        textSize, backgroundColor: args[10] ?? "", tooltip: pineString(args[11] ?? ""),
        textFontFamily: pineString(args[12] ?? "default"), textFormatting: pineString(args[13] ?? "format_none"), merged: false, mergeParent: null,
      });
      return null;
    }
    if (name === "clear") {
      const startColumn = tableCoordinate(args[1], "start_column", this.strictTableLimits);
      const startRow = tableCoordinate(args[2], "start_row", this.strictTableLimits);
      const endColumn = args[3] === undefined ? startColumn : tableCoordinate(args[3], "end_column", this.strictTableLimits);
      const endRow = args[4] === undefined ? startRow : tableCoordinate(args[4], "end_row", this.strictTableLimits);
      if (this.strictTableLimits) assertTableRange(table, startColumn, startRow, endColumn, endRow);
      if (this.strictTableLimits) {
        table.merges = table.merges.filter((merge) => {
          if (merge.endColumn < startColumn || merge.startColumn > endColumn || merge.endRow < startRow || merge.startRow > endRow) return true;
          for (let row = merge.startRow; row <= merge.endRow; row += 1) {
            for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
              const cell = table.cells[row]?.[column];
              if (cell !== null && cell !== undefined) { cell.merged = false; cell.mergeParent = null; }
            }
          }
          return false;
        });
      }
      for (let row = startRow; row <= endRow; row += 1) for (let column = startColumn; column <= endColumn; column += 1) if (table.cells[row]?.[column] !== undefined) table.cells[row]![column] = null;
      return null;
    }
    if (name === "merge_cells") {
      const startColumn = tableCoordinate(args[1], "start_column", this.strictTableLimits);
      const startRow = tableCoordinate(args[2], "start_row", this.strictTableLimits);
      const endColumn = tableCoordinate(args[3], "end_column", this.strictTableLimits);
      const endRow = tableCoordinate(args[4], "end_row", this.strictTableLimits);
      if (this.strictTableLimits) assertTableRange(table, startColumn, startRow, endColumn, endRow);
      if (this.strictTableLimits && table.merges.some((merge) =>
        merge.startColumn <= endColumn && merge.endColumn >= startColumn && merge.startRow <= endRow && merge.endRow >= startRow)) {
        throw new Error("Table merge overlaps an existing merged region");
      }
      for (let row = startRow; row <= endRow; row += 1) for (let column = startColumn; column <= endColumn; column += 1) {
        if (row === startRow && column === startColumn) continue;
        const cell = tableCell(table, column, row, true, this.strictTableLimits);
        if (cell !== undefined) { cell.merged = true; cell.mergeParent = [startColumn, startRow]; }
      }
      table.merges.push({ startColumn, startRow, endColumn, endRow });
      return null;
    }
    const propertyBySetter: Readonly<Record<string, keyof MutableTableCell>> = {
      cell_set_text: "text", cell_set_bgcolor: "backgroundColor", cell_set_text_color: "textColor",
      cell_set_text_size: "textSize", cell_set_height: "height", cell_set_width: "width", cell_set_tooltip: "tooltip",
      cell_set_text_halign: "textHorizontalAlign", cell_set_text_valign: "textVerticalAlign", cell_set_text_font_family: "textFontFamily",
      cell_set_text_formatting: "textFormatting",
    };
    const property = propertyBySetter[name];
    if (property !== undefined) {
      const textSize = property === "textSize" ? this.tableTextSize(args[3] ?? Number.NaN) : undefined;
      const cell = tableCell(table, tableCoordinate(args[1], "column", this.strictTableLimits), tableCoordinate(args[2], "row", this.strictTableLimits), true, this.strictTableLimits);
      if (cell !== undefined) {
        const value = textSize ?? (property === "text" || property === "tooltip" ? pineString(args[3] ?? "") : args[3] ?? Number.NaN);
        (cell as Record<string, PineValue>)[property] = value;
      }
      return null;
    }
    if (name === "set_position") {
      const position = this.tablePosition(args[1]);
      table.position = position;
    }
    else if (name === "set_bgcolor") table.backgroundColor = args[1] ?? Number.NaN;
    else if (name === "set_border_color") table.borderColor = args[1] ?? Number.NaN;
    else if (name === "set_border_width") table.borderWidth = integer(args[1] ?? 0);
    else if (name === "set_frame_color") table.frameColor = args[1] ?? Number.NaN;
    else if (name === "set_frame_width") table.frameWidth = integer(args[1] ?? 0);
    else throw new Error(`Unsupported table call table.${name}`);
    return null;
  }
}

export function drawingCast(name: string, value: PineValue | undefined, owner?: DrawingRuntime, strict = false): PineValue {
  if (isNa(value)) return null;
  if (strict && owner !== undefined) {
    if (!owner.ownsCastReference(name, value!)) {
      throw new PineRuntimeError(`${name}() requires an owned ${name} reference`, name);
    }
    return value!;
  }
  if (name === "line" && isPineLine(value)) return value;
  if (name === "box" && isPineBox(value)) return value;
  if (name === "label" && isPineLabel(value)) return value;
  if (name === "linefill" && isPineLinefill(value)) return value;
  if (name === "polyline" && isPinePolyline(value)) return value;
  if (name === "table" && isPineTable(value)) return value;
  return null;
}


export function isPineLine(value: PineValue | undefined): value is PineValue & MutablePineLine {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pineLine === true;
}

export function isPineBox(value: PineValue | undefined): value is PineValue & MutablePineBox {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pineBox === true;
}

export function isPineLabel(value: PineValue | undefined): value is PineValue & MutablePineLabel {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pineLabel === true;
}

function chartPoint(time: PineValue | undefined, index: PineValue | undefined, price: PineValue | undefined): MutableChartPoint {
  return { __pineChartPoint: true, time: typeof time === "number" ? time : null, index: typeof index === "number" ? index : null, price: number(price) };
}

export function isChartPoint(value: PineValue | undefined): value is PineValue & MutableChartPoint {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pineChartPoint === true;
}

function chartPointX(point: MutableChartPoint | undefined): number {
  if (point === undefined) return Number.NaN;
  if (typeof point.index === "number" && !Number.isNaN(point.index)) return point.index;
  return typeof point.time === "number" ? point.time : Number.NaN;
}

function linePointX(point: MutableChartPoint, xloc: string): number {
  const coordinate = xloc === "bt" ? point.time : point.index;
  return typeof coordinate === "number" ? coordinate : Number.NaN;
}

function labelPointX(point: MutableChartPoint, xloc: string): number {
  const coordinate = xloc === "bt" ? point.time : point.index;
  return typeof coordinate === "number" ? coordinate : Number.NaN;
}

function labelNumber(value: PineValue | undefined, field: string, integerOnly: boolean, strict: boolean): number {
  if (!strict) return number(value);
  if (typeof value !== "number" || (!Number.isFinite(value) && !Number.isNaN(value))
    || (integerOnly && !Number.isNaN(value) && !Number.isInteger(value))) {
    throw new PineRuntimeError(`label.${field} requires ${integerOnly ? "an integer" : "a number"}`, `label.${field}`);
  }
  return value;
}

function labelText(value: PineValue | undefined, field: string, fallback: string, strict: boolean): string {
  if (value === undefined) return fallback;
  if (strict && typeof value !== "string") throw new PineRuntimeError(`label.${field} requires a string`, `label.${field}`);
  return pineString(value);
}

function labelColor(value: PineValue | undefined, field: string, fallback: PineValue, strict: boolean): PineValue {
  if (value === undefined) return fallback;
  if (strict && typeof value !== "string" && !(typeof value === "number" && Number.isNaN(value))) {
    throw new PineRuntimeError(`label.${field} requires a color`, `label.${field}`);
  }
  return value;
}

const labelOptionValues: Readonly<Record<string, readonly string[]>> = {
  xloc: ["bi", "bt"],
  yloc: ["pr", "ab", "bl"],
  style: ["style_label_down", "style_label_up", "style_label_left", "style_label_right", "style_label_center",
    "style_label_lower_left", "style_label_lower_right", "style_label_upper_left", "style_label_upper_right",
    "style_circle", "style_square", "style_diamond", "style_arrowdown", "style_arrowup", "style_cross",
    "style_flag", "style_none", "style_text_outline", "style_triangledown", "style_triangleup", "style_xcross"],
  size: ["auto", "tiny", "small", "normal", "large", "huge"],
  textalign: ["left", "center", "right"],
  text_font_family: ["default", "monospace"],
};

function labelOption(value: PineValue | undefined, field: string, fallback: string, strict: boolean): string {
  if (value === undefined) return fallback;
  const result = pineString(value);
  if (strict && (typeof value !== "string" || !labelOptionValues[field]?.includes(result))) {
    throw new PineRuntimeError(`label.${field} requires a supported ${field} value`, `label.${field}`);
  }
  return result;
}

function labelSize(value: PineValue | undefined, strict: boolean): string {
  if (value === undefined) return "normal";
  if (typeof value === "number") {
    if (strict && (!Number.isInteger(value) || value < 0 || value > 100)) {
      throw new PineRuntimeError("label.size requires an integer from 0 to 100", "label.size");
    }
    return String(value);
  }
  return labelOption(value, "size", "normal", strict);
}

function chartPointXloc(point: MutableChartPoint | undefined): string {
  return point !== undefined && typeof point.index === "number" && !Number.isNaN(point.index) ? "bi" : "bt";
}

export function isPinePolyline(value: PineValue | undefined): value is PineValue & MutablePinePolyline {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pinePolyline === true;
}

export function isPineLinefill(value: PineValue | undefined): value is PineValue & MutablePineLinefill {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pineLinefill === true;
}

export function isPineTable(value: PineValue | undefined): value is PineValue & MutablePineTable {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, PineValue>>).__pineTable === true;
}

const TABLE_POSITIONS = new Set([
  "top_left", "top_center", "top_right",
  "middle_left", "middle_center", "middle_right",
  "bottom_left", "bottom_center", "bottom_right",
]);

function validPineDrawingColor(value: PineValue | undefined): boolean {
  return value === undefined || isNa(value) || (typeof value === "string" && value.length > 0);
}

const TABLE_TEXT_SIZES = new Set(["auto", "tiny", "small", "normal", "large", "huge"]);

function tableDimension(value: PineValue, name: "columns" | "rows", strict: boolean): number {
  const dimension = number(value);
  if (strict && (!Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error(`Table ${name} must be a positive integer`);
  }
  return Math.max(1, integer(value));
}

function tableCoordinate(value: PineValue | undefined, name: string, strict: boolean): number {
  const coordinate = number(value ?? 0);
  if (strict && !Number.isInteger(coordinate)) throw new Error(`Table ${name} must be an integer`);
  return integer(value ?? 0);
}

function assertTableRange(
  table: MutablePineTable,
  startColumn: number,
  startRow: number,
  endColumn: number,
  endRow: number,
): void {
  if (endColumn < startColumn || endRow < startRow) throw new Error("Table range end must not precede its start");
  if (startColumn < 0 || endColumn >= table.columns) {
    throw new Error(`Table column range ${String(startColumn)}..${String(endColumn)} is outside 0..${String(table.columns - 1)}`);
  }
  if (startRow < 0 || endRow >= table.rows) {
    throw new Error(`Table row range ${String(startRow)}..${String(endRow)} is outside 0..${String(table.rows - 1)}`);
  }
}

function tableCell(table: MutablePineTable, column: number, row: number, create: boolean, strict = false): MutableTableCell | undefined {
  if (row < 0 || row >= table.rows || column < 0 || column >= table.columns) {
    if (strict) {
      throw new Error(`Table cell (${String(column)}, ${String(row)}) is outside ${String(table.columns)} columns by ${String(table.rows)} rows`);
    }
    return undefined;
  }
  const existing = table.cells[row]?.[column];
  if (existing?.merged === true && existing.mergeParent !== null) return tableCell(table, existing.mergeParent[0], existing.mergeParent[1], create, strict);
  if (existing !== null && existing !== undefined) return existing;
  if (!create) return undefined;
  const cell: MutableTableCell = {
    text: "", width: 0, height: 0, textColor: "#000000", textHorizontalAlign: "center", textVerticalAlign: "center",
    textSize: "normal", backgroundColor: "", tooltip: "", textFontFamily: "default", textFormatting: "format_none", merged: false, mergeParent: null,
  };
  table.cells[row]![column] = cell;
  return cell;
}
