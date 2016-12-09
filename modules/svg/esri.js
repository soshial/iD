import * as d3 from 'd3';
import _ from 'lodash';
import { geoExtent, geoPolygonIntersectsPolygon } from '../geo/index';
import { osmEntity, osmNode, osmRelation, osmWay } from '../osm/index';

import { actionAddEntity } from '../actions/index';
import { modeSelect } from '../modes/index';

import { utilDetect } from '../util/detect';
import toGeoJSON from 'togeojson';
import fromEsri from 'esri-to-geojson';

layerImports = {};
knownObjectIds = {};

export function svgEsri(projection, context, dispatch) {
    var showLabels = true,
        detected = utilDetect(),
        layer;


    function init() {
        if (svgEsri.initialized) return;  // run once

        svgEsri.geojson = {};
        svgEsri.enabled = true;

        function over() {
            d3.event.stopPropagation();
            d3.event.preventDefault();
            d3.event.dataTransfer.dropEffect = 'copy';
        }

        d3.select('body')
            .attr('dropzone', 'copy')
            .on('drop.localesri', function() {
                d3.event.stopPropagation();
                d3.event.preventDefault();
                if (!detected.filedrop) return;
                drawEsri.files(d3.event.dataTransfer.files);
            })
            .on('dragenter.localesri', over)
            .on('dragexit.localesri', over)
            .on('dragover.localesri', over);

        svgEsri.initialized = true;
    }


    function drawEsri(selection) {
        var geojson = svgEsri.geojson,
            enabled = svgEsri.enabled;

        layer = selection.selectAll('.layer-esri')
            .data(enabled ? [0] : []);

        layer.exit();
            //.remove();

        layer = layer.enter()
            .append('g')
            .attr('class', 'layer-esri')
            .merge(layer);

        var entities = [];
        (geojson.features || []).map(function(d) {
            // don't reload the same objects over again
            if (knownObjectIds[d.properties.OBJECTID]) {
                return;
            }
            knownObjectIds[d.properties.OBJECTID] = true;
        
            var props, nodes, ln, way;
            function makeEntity(loc_or_nodes) {
                props = {
                    tags: d.properties,
                    visible: true
                };
            
                // don't bring the service's OBJECTID any further
                delete props.tags.OBJECTID;
                
                if (loc_or_nodes.length && (typeof loc_or_nodes[0] === 'string')) {
                    props.nodes = loc_or_nodes;
                } else {
                    props.loc = loc_or_nodes;
                }
                return props;
            }
                
            function makeMiniNodes(pts) {
                var nodes = [];
                for (var p = 0; p < pts.length; p++) {
                    props = makeEntity(pts[p]);
                    props.tags = {};
                    var node = new osmNode(props);
                    context.perform(
                        actionAddEntity(node),
                        'adding node inside a way'
                    );
                    nodes.push(node.id);
                }
                return nodes;
            }
                
            if (d.geometry.type === 'Point') {
                props = makeEntity(d.geometry.coordinates);
                var node = new osmNode(props);
                context.perform(
                    actionAddEntity(node),
                    'adding point'
                );
                  
            } else if (d.geometry.type === 'LineString') {
                nodes = makeMiniNodes(d.geometry.coordinates);
                props = makeEntity(nodes);
                way = new osmWay(props, nodes);
                context.perform(
                    actionAddEntity(way),
                    'adding way'
                );
                    
            } else if (d.geometry.type === 'MultiLineString') {
                for (ln = 0; ln < d.geometry.coordinates.length; ln++) {
                    nodes = makeMiniNodes(d.geometry.coordinates[ln]);
                    props = makeEntity(nodes);
                    way = new osmWay(props);
                    context.perform(
                        actionAddEntity(way),
                        'adding way within MultiLineString'
                    );
                }
                    
            } else if (d.geometry.type === 'Polygon') {
                d.properties.area = d.properties.area || 'yes';
                nodes = makeMiniNodes(d.geometry.coordinates[0]);
                props = makeEntity(nodes);
                way = new osmWay(props);
                context.perform(
                    actionAddEntity(way),
                    'adding way within Polygon'
                );
                    
            } else if (d.geometry.type === 'MultiPolygon') {
                d.properties.area = d.properties.area || 'yes';
                for (ln = 0; ln < d.geometry.coordinates.length; ln++) {
                    nodes = makeMiniNodes(d.geometry.coordinates[ln][0]);
                    props = makeEntity(nodes);
                    context.perform(
                        actionAddEntity(way),
                        'adding way within MultiPolygon'
                    );
                }
            }
        });
        
        return this;
    }


    drawEsri.showLabels = function(_) {
        if (!arguments.length) return showLabels;
        showLabels = _;
        return this;
    };


    drawEsri.enabled = function(_) {
        if (!arguments.length) return svgEsri.enabled;
        svgEsri.enabled = _;
        dispatch.call('change');
        return this;
    };


    drawEsri.hasData = function() {
        var geojson = svgEsri.geojson;
        return (!(_.isEmpty(geojson) || _.isEmpty(geojson.features)));
    };


    drawEsri.geojson = function(gj) {
        if (!arguments.length) return svgEsri.geojson;
        if (_.isEmpty(gj) || _.isEmpty(gj.features)) return this;
        svgEsri.geojson = gj;
        dispatch.call('change');
        return this;
    };


    drawEsri.url = function(true_url) {
        var url = true_url;
        if (url.indexOf('outSR') === -1) {
            url += '&outSR=4326';
        }
        if (url.indexOf('&f=') === -1) {
            url += '&f=json';
        }        
        
        var bounds = context.map().trimmedExtent().bbox();
        bounds = JSON.stringify({
            xmin: bounds.minX.toFixed(6),
            ymin: bounds.minY.toFixed(6),
            xmax: bounds.maxX.toFixed(6),
            ymax: bounds.maxY.toFixed(6),
            spatialReference: {
              wkid: 4326
            }
        });
        if (this.lastBounds === bounds) {
            // unchanged
            return this;
        }
        this.lastBounds = bounds;
        
        if (url.indexOf('spatialRel') === -1) {
            // don't overwrite a spatial query
            url += '&geometry=' + this.lastBounds;
            url += '&geometryType=esriGeometryEnvelope';
            url += '&spatialRel=esriSpatialRelIntersects';
            url += '&inSR=4326';
        }
        
        d3.text(url, function(err, data) {
            if (err) {
                console.log('Esri service URL did not load');
                console.error(err);
            } else {
                var esriTable = d3.selectAll('.esri-table').html('');
                
                var jsondl = fromEsri.fromEsri(JSON.parse(data));
                if (jsondl.features.length) {
                    var samplefeature = jsondl.features[0];
                    var keys = Object.keys(samplefeature.properties);
                    function doKey(r) {
                        if (r >= keys.length) {
                            return;
                        }
                        var row = esriTable.append('tr');
                        row.append('td').text(keys[r]);
                        var outfield = row.append('td').append('input');
                        outfield.attr('type', 'text')
                            .attr('name', keys[r])
                            .attr('placeholder', (layerImports[keys[r]] || samplefeature.properties[keys[r]]))
                            .on('change', function() {
                                //console.log(this.name + ' -> ' + this.value);
                                layerImports[this.name] = this.value;
                            });
                        doKey(r + 1);
                    }
                    doKey(0);
                    
                    var convertedKeys = Object.keys(layerImports);
                    if (convertedKeys.length) {
                        jsondl.features.map(function(selectfeature) {
                            var outprops = {
                                OBJECTID: selectfeature.properties.OBJECTID
                            };
                            for (var k = 0; k < convertedKeys.length; k++) {
                                var kv = selectfeature.properties[convertedKeys[k]];
                                if (kv) {
                                    outprops[layerImports[convertedKeys[k]]] = kv;
                                }
                            }
                            selectfeature.properties = outprops;
                            return selectfeature;
                        });
                    }
                } else {
                    console.log('no feature to build table from');
                }
                // console.log(jsondl);
                drawEsri.geojson(jsondl);
            }
        });
        
        context.map().on('move', function() {
            if (this.timeout) {
               clearTimeout(this.timeout);
            }
            this.timeout = setTimeout(function() {
                this.url(true_url);
            }.bind(this), 500);
        }.bind(this));
        
        return this;
    };

    drawEsri.fitZoom = function() {
        if (!this.hasData()) return this;
        var geojson = svgEsri.geojson;

        var map = context.map(),
            viewport = map.trimmedExtent().polygon(),
            coords = _.reduce(geojson.features, function(coords, feature) {
                var c = feature.geometry.coordinates;
                return _.union(coords, feature.geometry.type === 'Point' ? [c] : c);
            }, []);

        if (!geoPolygonIntersectsPolygon(viewport, coords, true)) {
            var extent = geoExtent(d3.geoBounds(geojson));
            map.centerZoom(extent.center(), map.trimmedExtentZoom(extent));
        }

        return this;
    };


    init();
    return drawEsri;
}
