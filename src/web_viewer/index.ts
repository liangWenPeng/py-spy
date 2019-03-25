import {default as d3flamegraph} from "d3-flame-graph";
import {json} from "d3-fetch";
import {interval, Timer} from "d3-timer";
import {mouse, event, select, selectAll} from "d3-selection";
import {brushX, BrushBehavior} from "d3-brush";
import {scaleLinear, ScaleLinear} from "d3-scale";
import {axisBottom} from "d3-axis";
import {Selection} from "d3-selection";
import {line, area, curveBasis} from "d3-shape";

const FLAME_GRAPH_CELL_HEIGHT = 18;
const MARGIN = {top: 20, right: 20, bottom: 20, left: 20};

// This class wraps the d3flamegraph package, and adds hooks for loading
// data from our REST api - and add a brushable CPU view of time etc
export class FlameGraph {
    public data: any = null;
    public times: TimeSeriesSelector;
    public flame_graph: any;
    public timer: Timer;

    constructor(public flame_element: HTMLElement, public timescale_element: HTMLElement) {
        this.times = new TimeSeriesSelector(this.timescale_element);
        this.times.load = (start: number, end: number) => { this.load_data(start, end); }
        selectAll(".flameoption").on("change", () => {
            this.times.load(this.times.selected[0], this.times.selected[1]);
        });

        let div = select(flame_element)
            // first outer div is for a scrollbar
            .append("div")
            /* TODO: eventually we will want elements below this, but for now can just scroll whole page
            .style("resize", "vertical")
            .style("overflow-y", "scroll")
            .style("overflow-x", "hidden")
            .style("min-height" , 5 * FLAME_GRAPH_CELL_HEIGHT + "px")
            .style("height", 20 * FLAME_GRAPH_CELL_HEIGHT + "px")
            */
            .style("margin-left", MARGIN.left + "px")
            .style("margin-right", MARGIN.right + "px");

        this.flame_element = div.nodes()[0] as HTMLElement;

        this.flame_graph = d3flamegraph.flamegraph()
            .cellHeight(FLAME_GRAPH_CELL_HEIGHT)
            .inverted(true)
            .sort(true)
            .width(this.flame_element.offsetWidth);

        this.load_stats();
        this.timer = interval(() => this.load_stats(), 1000);

        // handle resizes somewhat gracefully
        window.addEventListener("resize", () => {
            this.times.resize();
            if (this.data !== null) {
                this.flame_graph.width(this.flame_element.offsetWidth);
                select(this.flame_element)
                    .datum(this.data)
                    .call(this.flame_graph)
                    .select("svg")
                    .attr("width", this.flame_element.offsetWidth);
            }
        });
    }

    public load_stats(): void {
        json("/stats/")
            .then((d: any) => {
                if (!d.running) {
                    this.timer.stop();
                    document.getElementById("runningstate").textContent = "stopped";
                }

                document.getElementById("python_version").textContent = d.version;
                document.getElementById("sampling_rate").textContent = d.sampling_rate;

                if (d.python_command.length) {
                    document.getElementById("python_command").textContent = d.python_command;
                }

                // Get the gil/thread activity in a format we want
                let active = d.threads[0][1];
                for (let [thread, values] of d.threads.slice(1)) {
                    for (let i  = 0; i < values.length; ++i) {
                        active[i] += values[i];
                    }
                }
                let max_active = Math.ceil(Math.max.apply(null, active) - .4);
                let active_name = '% Active';
                if (max_active > 1) {
                    for (let i = 0; i < active.length; ++i) {
                        active[i] /= max_active;
                    }
                    active_name = active_name + " (out of " + max_active  + " threads)";
                }

                let data = [{name: active_name, values: active, legend_x: 50, colour: "#1f77b4" },
                             {name: '% GIL', values: d.gil, legend_x: 0, colour: "#ff7f0e"}];
                this.times.update(data);
            })
            .catch(err => {
                console.log(err);
                throw(err);
            });
    }

    public load_data(start: number, end: number): void {
        let url = "/aggregates/" + Math.floor(start * 1000) + "/" + Math.floor(end * 1000);

        // ugh: probably could do this better by posting a form? rathere than building
        // up the url like this?
        let first_param = true;
        for (let name of ["include_threads", "include_idle", "gil_only", "include_lines"]) {
            if ((document.getElementById(name) as HTMLInputElement).checked) {
                if (first_param) {
                    first_param = false;
                    url += "?" + name + "=1"
                } else {
                    url += "&" + name + "=1"
                }
            }
        }

        // store a reference to the data (needed to update flamegraph on resize etc)
        json(url)
            .then((d: any) => {
                document.getElementById("startselection").textContent = start.toFixed(3) + "s";
                document.getElementById("endselection").textContent = end.toFixed(3) + "s";
                // TODO: we're not setting the appropiate sample count on root
                let count = 0;
                for (let child of d.children) {
                    count += child.value;
                }
                document.getElementById("countselection").textContent = count.toLocaleString();

                // store reference so that we can redraw easily on resize
                this.data = d;

                select(this.flame_element)
                    .datum(d)
                    .call(this.flame_graph);
            })
            .catch(err => {
                console.log("Failed to get", url, err);
            });
    }
}

/// Brushable time-series graph. Used to show cpu-usage over time
/// and select a time range to drill down into
export class TimeSeriesSelector {
    public x_scale: ScaleLinear<number, number>;
    public y_scale: ScaleLinear<number, number>;
    public brush: BrushBehavior<{}>;

    public selected: number[] = [0, 0];
    public loaded: number[] = [0, 0];
    public total_time_range: number[] = [0, 1];
    public width: number;
    public height: number;

    public group: Selection<SVGGElement, {}, null, undefined>;
    public stats_group: Selection<SVGGElement, {}, null, undefined>;

    public brushing: boolean = false;
    public brush_timeout: NodeJS.Timeout = null;

    public load: (start: number, end: number) => void;

    protected data: any;

    constructor(public element: HTMLElement) {
        var svg = select(this.element).append("svg")
            .attr("class", "timescale")
            .attr("width", this.element.offsetWidth)
            .attr("height", 80);

        this.load = (start: number, end: number) => {  }

        // some elements (scale/handles) will extend past these width here
        // so we're creating the SVG and then translating main elements to create a
        // the margin (rather than putting in div)
        this.width = +svg.attr("width") - MARGIN.left - MARGIN.right;
        this.height = +svg.attr("height") - MARGIN.top - MARGIN.bottom;
        this.group = svg.append("g").attr("transform", "translate(" + MARGIN.left + "," + MARGIN.top + ")");
        this.stats_group = this.group.append("g");

        this.x_scale = scaleLinear()
            .domain([0, 1])
            .range([0, this.width]);

        this.y_scale = scaleLinear()
            .domain ([0, 1])
            .range([this.height, 0]);

        let load_selected = () => {
            this.brushing = false;
            if ((Math.abs(this.selected[0] - this.loaded[0]) > 0.0001) ||
                (Math.abs(this.selected[1] - this.loaded[1]) > 0.0001)) {
                this.loaded = this.selected;
                this.load(this.loaded[0], this.loaded[1]);
            }
        }

        let set_brush_timeout = () => {
            this.brush_timeout = setTimeout(load_selected, 1000);
        };

        this.brush = brushX()
            .extent([[0, 0], [this.width, this.height]])
            .on("start", () => {
                this.brushing = true;
                set_brush_timeout();
            })
            .on("brush", () => {
                clearTimeout(this.brush_timeout);
                set_brush_timeout();
                if (event.selection !== null) {
                    this.selected = event.selection.map(this.x_scale.invert, this.x_scale);
                }
            })
            .on("end", () => {
                this.brushing = false;
                clearTimeout(this.brush_timeout);
                load_selected();
            });

        this.group.append("g")
            .attr("class", "brush")
            .call(this.brush)
            .call(this.brush.move, this.selected.map(this.x_scale));

        this.group.append("g")
            .attr("class", "axis")
            .attr("transform", "translate(0," + this.height + ")")
            .call(axisBottom(this.x_scale).tickFormat(d => d + "s"));

        // make handles somewhat visible
        this.group.selectAll(".handle")
            .attr("stroke", "#888")
            .attr("stroke-opacity", .9)
            .attr("stroke-width", 1)
            .attr("fill", "#AAA")
            .attr("fill-opacity", .7)

        this.group.selectAll(".selection")
            .attr("fill-opacity", .1)
            .attr("stroke-opacity", 0.2);
    }

    public resize() {
        let width = this.element.offsetWidth;
        select(this.element).select("svg").attr("width", width);

        this.width = width - MARGIN.left - MARGIN.right;
        this.x_scale.range([0, this.width]);
        this.brush.extent([[0, 0], [this.width, this.height]]);

        // hack: transition in update seems to mess up selected somehow, override
        this.group.select(".brush").call(this.brush.move as any, this.selected.map(this.x_scale));

        this.update(this.data);
    }

    public update(data: any) {
        if (this.brushing) {
            return;
        }

        this.data = data;
        let elapsed = data[0].values.length / 10;
        this.total_time_range = [0, elapsed];

        if (this.selected[0] == 0 && this.selected[1] == 0) {
            this.selected = [0, elapsed];
        }
        this.x_scale.domain(this.total_time_range);

        this.group.select(".brush")
            .call(this.brush)
            .transition()
            .call(this.brush.move as any, this.selected.map(this.x_scale));

        this.group.select(".axis")
            .attr("transform", "translate(0," + this.height + ")")
            .transition()
            .call(axisBottom(this.x_scale).tickFormat(d => d + "s") as any);

        let cpu_scale = scaleLinear().domain([0, data[0].values.length - 1])
                          .range(this.total_time_range);

        var l = area()
            .curve(curveBasis as any)
            .y0(this.height)
            .y1((d:any) => this.y_scale(d))
            .x((d: any, i: number) =>  this.x_scale(cpu_scale(i)));

        let stats = this.stats_group.selectAll(".stat")
            .data(data);

        let enter = stats.enter()
            .append("g")
            .attr("class", "stat");

        enter
            .append("path")
            .attr("stroke", (d: any) => d.colour)
            .attr("fill", (d: any) => d.colour)
            .attr("fill-opacity", .05)
            .attr("stroke-width", 1)
            .attr("d", (d: any) => {
                return l(d.values)
            });

        enter.append("text")
            .attr("x", (d:any) => d.legend_x + 8)
            .attr("y", -8)
            .style("font-size", "10px")
            .text((d: any) => d.name);

        enter.append("rect")
            .attr("x", (d: any) => d.legend_x)
            .attr("y", -14)
            .attr("height", 5)
            .attr("width", 5)
            .attr("stroke", (d: any) => d.colour)
            .attr("fill", (d: any) => d.colour)
            .attr("fill-opacity", .1)
            .attr("stroke-width", 1);


        console.log(stats.selectAll("path"));

        stats.select("path").transition()
            .attr("d", (d: any) => {
                return l(d.values)
            });

        stats.select("text").transition()
            .text((d: any) => d.name);

    }

    protected set_brushtimeout() {

    }
}
