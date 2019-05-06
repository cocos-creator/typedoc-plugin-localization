import * as path from 'path';

import { Component, RendererComponent } from 'typedoc/dist/lib/output/components';
import { ReflectionKind } from 'typedoc/dist/lib/models';
import { FileOperations } from '../utils/file-operations';
import { AttributeType } from '../utils/enums/json-keys';
import { Constants } from '../utils/constants';
import { RendererEvent } from 'typedoc/dist/lib/output/events';
import { Parser } from '../utils/parser';

interface localization {
    chooseTag: string,
    removeTags: string[]
}
const availableLanguages = ['zh', 'en'];

@Component({ name: 'render-component'})
export class RenderComponenet extends RendererComponent {
    fileOperations: FileOperations;
    /**
     * Contains data per every processed Object like (Class, Inteface, Enum) 
     */
    data: JSON;
    /**
     * Main process dir.
     */
    mainDirOfJsons: string;
    /**
     * JSON data for all global funcs definitions.
     */
    globalFuncsData;
    /**
     * String parser
     */
    parser: Parser;

    /**
     * Localizing docs language
     */
    customLocalization: localization

    public initialize() {
        this.listenTo(this.owner, {
            [RendererEvent.BEGIN]: this.onRenderBegin,
        });
        this.fileOperations = new FileOperations(this.application.logger);
        this.parser = new Parser();
    }

    private onRenderBegin(event) {
        event.project.localization = this.application.options.getValue("localize");

        const reflections = event.project.reflections;
        const options = this.application.options.getRawValues();
        const localizeOpt = options[Constants.RENDER_OPTION];
        if (!options.localize) {
            this.customLocalization = undefined;
            return;
        }
        else {
            let languageList = availableLanguages;
            let chooseTag = languageList.splice(availableLanguages.indexOf(options.localize), 1);
            let removeTags = languageList;
            this.customLocalization = {
                chooseTag: chooseTag[0],
                removeTags: removeTags
            };
        }
        if (localizeOpt) {
            this.mainDirOfJsons = localizeOpt;
            this.globalFuncsData = this.fileOperations.getFileData(this.mainDirOfJsons, Constants.GLOBAL_FUNCS_FILE_NAME, 'json');
            this.runCommentReplacements(reflections);
        }
    }

    private runCommentReplacements(reflections) {
        const keys = Object.keys(reflections);
        keys.forEach(key => {
            const reflection = reflections[key];
            this.processTheReflection(reflection);
        });

        keys.forEach(key => {
            const reflection = reflections[key];
            // 修正 enum 重名问题的命名重调整，保证最终 enum 名称正确。
            if (reflection.kind === ReflectionKind.Enum) reflection.name = reflection.name.split('_')[0];
            // external 名称缩减，美化 global 页面。这里只是简单的处理，主要是为了避免多 fork 一个 default-theme 仓库，建议后期修正。
            if (reflection.parent && reflection.parent.name) reflection.parent.name = path.parse(reflection.parent.name.match(/[a-zA-Z0-9\/\\]/g).join('')).name;
        });
    }

    private processTheReflection(reflection) {
        switch(reflection.kind) {
            case ReflectionKind.Class:
            case ReflectionKind.Enum:
            case ReflectionKind.Interface:
                    const filePath = reflection.sources[0].fileName;
                    let processedDir = this.mainDirOfJsons;
                    const parsedPath = this.fileOperations.getProcessedDir(filePath);
                    if (parsedPath) {
                        processedDir = path.join(processedDir, parsedPath);
                    }
                    this.data = this.fileOperations.getFileData(processedDir, reflection.name, 'json');
                    if (this.data) {
                        this.updateComment(reflection, this.data[reflection.name]);
                    }
                break;
            case ReflectionKind.Property:
            case ReflectionKind.CallSignature:
            case ReflectionKind.EnumMember:
                   /**
                     * Skip reflections with type @ReflectionKind.Function because they are aslo @ReflectionKInd.CallSignature
                     * but the handling process here is not appropriate for them.
                     */
                    if (reflection.parent === ReflectionKind.Function) {
                        break;
                    }

                    const parent = this.getParentBasedOnType(reflection, reflection.kind);
                    const parentName = parent.name;
                    const attributeName = reflection.name;
                    const attributeData = this.getAttributeData(parentName, AttributeType[reflection.kind], attributeName);
                    if(attributeData) {
                        this.updateComment(reflection, attributeData);
                    }
                break;
            case ReflectionKind.Function:
                    if (!this.globalFuncsData) {
                        break;
                    }
                    const funcName = reflection.name;
                    const funcData = this.globalFuncsData[funcName];
                    this.updateComment(reflection.signatures[0], funcData);
                break;
            case ReflectionKind.GetSignature:
            case ReflectionKind.SetSignature:
                    const accessorParent = this.getParentBasedOnType(reflection, reflection.kind);
                    const accessor = reflection.parent;
                    const accessorSignature = reflection.kind;
                    const data = this.getAccessorAttributeData(accessorParent.name, AttributeType[accessor.kind], accessor.name, AttributeType[accessorSignature]);
                    if (data) {
                        this.updateComment(reflection, data);
                    }
                break;
            default:
                return;
        }
    }

    private getAttribute(parentName, attribute) {
        if (this.data && this.data[parentName]) {
            return this.data[parentName][attribute];
        }
    }

    private getAttributeData(parentName, attribute, attributeName) {
        const data = this.getAttribute(parentName, attribute);
        if (data) {
            return data[attributeName];
        }
    }

    private getAccessorAttributeData(parentName, attribute, attributeName, accessorType) {
        const data = this.getAttributeData(parentName, attribute, attributeName);
        if (data) {
            return data[accessorType];
        }
    }

    private updateComment(reflection, dataObj) {
        if (!reflection.comment || !dataObj[Constants.COMMENT]) {
            return;
        }

        let parsed;
        if (reflection.comment.text) {
            parsed = this.parser.joinByCharacter(dataObj[Constants.COMMENT][Constants.TEXT], '\n');
            reflection.comment.text = parsed;
        }

        if (reflection.comment.shortText) {
            parsed = this.parser.joinByCharacter(dataObj[Constants.COMMENT][Constants.SHORT_TEXT], '\n');
            reflection.comment.shortText = parsed;
        }
        // @ts-ignore
        if (reflection.comment.tags && dataObj[Constants.COMMENT][Constants.TAGS]) {
            let targetTags = reflection.comment.tags;
            if (this.customLocalization && targetTags.length > 0) {
                let index = targetTags.findIndex(t => { return t.tagName === this.customLocalization.chooseTag; });
                if (index >= 0) {
                    // replace to shortText
                    reflection.comment.shortText += `\n\n${targetTags[index].text}`;
                    targetTags.splice(index, 1);

                    // remove language tag
                    let removeTags = this.customLocalization.removeTags;
                    for (let i = 0; i < removeTags.length; i++) {
                        index = targetTags.findIndex(t => { return t.tagName === removeTags[i]; });
                        if (index < 0) continue;
                        targetTags.splice(index, 1);
                    }
                    reflection.comment.tags = targetTags;
                    console.log(`Replace language success: ${reflection.name}`);
                }
            }
            let name = reflection.name;
            let sourceFile = reflection.sources[0].fileName;
            reflection.comment.tags.forEach(tag => {
                const tagFromJson = dataObj[Constants.COMMENT][Constants.TAGS][tag.tagName];
                tag.tagName = tagFromJson ? tagFromJson[Constants.COMMENT].tagName : tag.tagName;
                tag.text = tagFromJson ? this.parser.joinByCharacter(tagFromJson[Constants.COMMENT].text, '\n') : 'lost!';
                !tagFromJson && console.log(`render-component: ${sourceFile} : ${name}`)
                return tag;
            });
        }

        if (reflection.parameters && dataObj[Constants.COMMENT][Constants.PARAMS]) {
            reflection.parameters.forEach(param => {
                const paramFromJson = dataObj[Constants.COMMENT][Constants.PARAMS][param.name];
                if (paramFromJson) {
                    param.comment.text = this.parser.joinByCharacter(paramFromJson[Constants.COMMENT].text, '\n');
                    return param;
                }
            });
        }
    }

    /**
     * Returns the parent(Class, Interface, Enum) per every Method, Property, Getter, Setter etc.
     * @param reflection 
     * @param kind 
     */
    private getParentBasedOnType(reflection, kind) {
        if (kind === ReflectionKind.CallSignature || 
            kind === ReflectionKind.GetSignature || 
            kind === ReflectionKind.SetSignature) {
                return reflection.parent.parent;
        }

        return reflection.parent;
    }
}